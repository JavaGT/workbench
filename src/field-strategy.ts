// The field-type persistence strategy table + the validate pipeline stage.
//
// SPEC §5.1, §7 (stage 1: validate), §7.2 ("the field-type plugin owns the
// persistence strategy"). The four KINDS — value/store/crdt/ordered — are named
// wholes (ADR #9), each owning genuinely distinct {validate, apply, diff}
// machinery. The strategy is resolved by `kind` from ONE framework-owned table;
// a descriptor carries only its kind, never an embedded strategy object. This is
// the deletion test passing: the kind ABSORBS the strategy (no per-field config
// object that merely relocates the machinery behind a name).
//
// Phase 1's blog spine exercises `value` (whole-value diff: text/ref/
// boolean/date) and the structural-validate half of `crdt` (note.mjs body). The
// crdt/store/ordered/struct MERGE machinery (per-element deltas, fractional
// index, per-sub-cell diff) lands in Phase 2 — registered here as named wholes
// whose diff produces element-level deltas (consult #18/#20).

import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { tryBetterAuthHash } from './hash-compat.ts';

const NATIVE_SCRYPT_PREFIX = 'scrypt:';
const LEGACY_HEX_HASH_RE = /^[0-9a-f]+:[0-9a-f]{128}$/i;

function scryptAsync(
  password: string,
  salt: Buffer | string,
  keylen: number,
  options?: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (err: Error | null, derivedKey: Buffer) => {
      if (err) reject(err);
      else resolve(derivedKey);
    };
    if (options) scrypt(password, salt, keylen, options, callback);
    else scrypt(password, salt, keylen, callback);
  });
}

function parsePrefixedNativeHash(stored: string): { salt: Buffer; expected: Buffer } | null {
  const body = stored.slice(NATIVE_SCRYPT_PREFIX.length);
  const sep = body.indexOf(':');
  if (sep <= 0) return null;
  const saltHex = body.slice(0, sep);
  const expectedHex = body.slice(sep + 1);
  if (saltHex.length === 0 || saltHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(saltHex)) return null;
  if (expectedHex.length !== 128 || !/^[0-9a-f]+$/i.test(expectedHex)) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (salt.length === 0 || expected.length !== 64) return null;
  return { salt, expected };
}

function parseLegacyHexHash(stored: string): { saltHex: string; salt: Buffer; expected: Buffer } | null {
  if (!LEGACY_HEX_HASH_RE.test(stored)) return null;
  const sep = stored.indexOf(':');
  const saltHex = stored.slice(0, sep);
  if (saltHex.length === 0 || saltHex.length % 2 !== 0) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(stored.slice(sep + 1), 'hex');
  if (salt.length === 0 || expected.length !== 64) return null;
  return { saltHex, salt, expected };
}

// A field descriptor as the strategy table sees it: kind, value type, and the
// option surface the validate/serialize seams read. Kept loose — the descriptor
// is built by field.mjs and consumed by many layers.
export interface FieldDescriptor {
  readonly kind: string;
  readonly type?: string;
  readonly validate?: ((value: unknown) => string | true) | undefined;
  readonly canonicalize?: ((value: unknown) => unknown) | undefined;
  readonly required?: boolean | undefined;
  readonly nullable?: boolean | undefined;
  readonly readonly?: boolean | undefined;
  readonly touch?: boolean | undefined;
  readonly dimensions?: number | undefined;
  readonly cells?: Readonly<Record<string, FieldDescriptor>> | undefined;
  readonly values?: readonly unknown[] | undefined;
  readonly [property: string]: unknown;
}

export interface EntityRecord {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDescriptor>>;
}

// A typed failure for the validate stage. Stage 1 throws this and NOTHING
// downstream runs (no apply, no persist, no emit) — a bad payload never proceeds
// (SPEC §7 stage 1, fail closed). The message names the field path + reason.
export class ValidationError extends Error {
  failure: unknown;

  constructor(message: string, failureDetails?: unknown) {
    super(message);
    this.name = 'ValidationError';
    // Optional structured failure details (JSON-safe record) attached to the
    // invalid-input failure so clients can classify a rejection without
    // parsing its human-readable message.
    if (failureDetails !== undefined) this.failure = failureDetails;
  }
}

// Structural validators per kind. These check the SHAPE the kind can store,
// before any declared `validate` runs. A declared validate refines; the
// structural check is the floor.
function isTextValue(v: unknown): v is string {
  return typeof v === 'string';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((item) => isJsonValue(item, seen));
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).every((item) => isJsonValue(item, seen));
  }
  return false;
}

interface StoreMembershipDelta {
  added: { member: string; role: unknown }[];
  removed: string[];
  changed: { member: string; role: unknown }[];
}

// store (map) membership diff over { member: role } materializations. A member
// add → added; a member gone → removed; a same-member role change → changed
// (NOT added — only a NEW member fires native added, DECISIONLOG #57).
function storeMapDiff(previous: unknown, next: unknown): StoreMembershipDelta | null {
  const prev = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>;
  const nxt = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
  const added: { member: string; role: unknown }[] = [];
  const removed: string[] = [];
  const changed: { member: string; role: unknown }[] = [];
  for (const [member, role] of Object.entries(nxt)) {
    if (!(member in prev)) added.push({ member, role });
    else if (!Object.is(prev[member], role)) changed.push({ member, role });
  }
  for (const member of Object.keys(prev)) {
    if (!(member in nxt)) removed.push(member);
  }
  if (!added.length && !removed.length && !changed.length) return null;
  return { added, removed, changed };
}

// struct per-sub-cell diff. Only changed declared sub-cells appear in `cells`
// as { set: value }; an unchanged sub-cell is absent. A cleared cell → { set: null }.
function structDiff(previous: unknown, next: unknown, descriptor?: FieldDescriptor): { cells: Record<string, { set: unknown }> } | null {
  const prev = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>;
  const nxt = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
  const declared = (descriptor?.cells ?? {}) as Readonly<Record<string, unknown>>;
  const cells: Record<string, { set: unknown }> = {};
  for (const name of Object.keys(nxt)) {
    if (Object.prototype.hasOwnProperty.call(declared, name) && !Object.is(prev[name], nxt[name])) {
      cells[name] = { set: nxt[name] };
    }
  }
  for (const name of Object.keys(prev)) {
    if (Object.prototype.hasOwnProperty.call(declared, name) && !(name in nxt) && prev[name] != null) {
      cells[name] = { set: null };
    }
  }
  if (Object.keys(cells).length === 0) return null;
  return { cells };
}

// The named-whole algebraic laws a field kind's mutations obey. Consulted by
// undo (invertible), log compaction (coalescible), and derivation consumers.
export interface StrategyLaws {
  readonly invertible: boolean;
  readonly coalescible: boolean;
  readonly idempotent: boolean;
  readonly commutativeMerge: boolean;
}

export interface FieldStrategy {
  readonly laws: StrategyLaws;
  readonly validate: (value: unknown, descriptor?: FieldDescriptor) => string | true;
  readonly apply: (previous: unknown, next: unknown) => unknown;
  readonly diff?: (previous: unknown, next: unknown, descriptor?: FieldDescriptor) => unknown | null;
  readonly serialize?: (value: unknown, descriptor?: FieldDescriptor) => unknown;
  readonly deserialize?: (value: unknown, descriptor?: FieldDescriptor) => unknown;
}

// The four named-whole strategies. value is fully implemented (whole-value diff);
// The FIELD-TYPE CONTRACTS table. A field descriptor carries only `kind`; the
// strategy is resolved at call time from this frozen table. This is a CLOSED set
// of framework-owned types (SPEC §5.1's "open registry" is aspirational — there is
// no external registration API in this beta). Adding a new kind means editing this
// table, the field constructors in field.mjs, and the resolveStrategy error
// message. The deletion test (AGENTS.md) confirms that kind absorbs strategy
// (concentrates), rather than relocating it onto each descriptor.
export const STRATEGIES: Readonly<Record<string, FieldStrategy>> = Object.freeze({
  // `value` — a single stored value with whole-value diff. apply replaces;
  // diff is a whole-value set, null when unchanged.
  value: Object.freeze({
    laws: Object.freeze({ invertible: true, coalescible: true, idempotent: false, commutativeMerge: false }),
    validate(value: unknown, descriptor?: FieldDescriptor) {
      switch (descriptor?.type) {
        case 'text':
          if (!isTextValue(value)) return 'expected a text value';
          return true;
        case 'ref':
          if (typeof value !== 'string' && typeof value !== 'number') return 'expected a ref value';
          return true;
        case 'boolean':
          if (typeof value !== 'boolean') return 'expected a boolean';
          return true;
        case 'date':
          if (value instanceof Date && !Number.isFinite(value.getTime())) {
            return 'field.invalid-date';
          }
          if (typeof value === 'number' && !Number.isFinite(value)) {
            return 'field.invalid-date';
          }
          if (!(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string') {
            return 'expected a date';
          }
          return true;
        case 'json':
          if (!isJsonValue(value)) return 'expected a JSON value';
          return true;
        case 'vector': {
          // Accept a JSON string (from stored cell) or a number[] (from client).
          let vec: unknown = value;
          if (typeof value === 'string') {
            try { vec = JSON.parse(value); } catch { return 'expected a JSON-encoded vector array'; }
          }
          if (!Array.isArray(vec)) return 'expected a vector array';
          if (!vec.every((v) => typeof v === 'number' && Number.isFinite(v))) {
            return 'expected a vector of finite numbers';
          }
          if (vec.length !== descriptor?.dimensions) {
            return `expected vector of length ${descriptor?.dimensions}, got ${vec.length}`;
          }
          return true;
        }
        default:
          return true;
      }
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown) {
      if (Object.is(previous, next)) return null;
      return { set: next };
    },
    // serialize maps a value-kind value to its stored cell. SQLite has no boolean
    // type and node:sqlite refuses to bind a JS boolean, so a boolean becomes the
    // integer 1/0; a Date becomes epoch millis; text/ref/already-stored values
    // pass through. null/undefined are left untouched (a null cell is null). This
    // is the ONE place "how a value-kind field becomes a stored cell" is decided —
    // used by both the scope-literal baker and the write path (singular system).
    serialize(value: unknown, descriptor?: FieldDescriptor) {
      if (value === null || value === undefined) return value;
      switch (descriptor?.type) {
        case 'boolean':
          return value ? 1 : 0;
        case 'date':
          return value instanceof Date ? value.getTime() : value;
        case 'ref':
          return String(value);
        case 'json':
          return JSON.stringify(value);
        case 'vector':
          return JSON.stringify(value);
        default:
          return value;
      }
    },
    deserialize(value: unknown, descriptor?: FieldDescriptor) {
      if (value === null || value === undefined) return value;
      switch (descriptor?.type) {
        case 'boolean':
          return value ? true : false;
        case 'json':
          if (typeof value !== 'string') return value;
          return JSON.parse(value);
        case 'vector':
          if (typeof value !== 'string') return value;
          return JSON.parse(value);
        default:
          return value;
      }
    },
  }),

  // `hash` — a one-way salted password digest. A plaintext string in, a salted
  // scrypt digest (`salt:digest`, hex) stored. apply replaces (whole-value); diff
  // compares the STORED cells, so re-storing the same plaintext (a fresh salt)
  // reads as a change — passwords are write-only, never diffed for equality of
  // plaintext. verify is exposed on the hydrated row, not here.
  hash: Object.freeze({
    laws: Object.freeze({ invertible: false, coalescible: false, idempotent: false, commutativeMerge: false }),
    validate(value: unknown) {
      if (!isTextValue(value)) return 'expected a password string';
      return true;
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown) {
      if (Object.is(previous, next)) return null;
      return { set: next };
    },
    // serialize digests the plaintext: random 16-byte salt + scrypt(64) →
    // `scrypt:saltHex:digestHex`. null/undefined pass through (a null cell is null).
    serialize(value: unknown) {
      if (value === null || value === undefined) return value;
      const salt = randomBytes(16);
      const digest = scryptSync(value as string, salt, 64);
      return `${NATIVE_SCRYPT_PREFIX}${salt.toString('hex')}:${digest.toString('hex')}`;
    },
  }),

  // `crdt` — text operations use annotated-text.mjs directly. Raster/polyline
  // remain explicit whole-value replacement stubs until their merge toolkit lands.
  crdt: Object.freeze({
    // Text operations need authored compensating operations; generic history
    // cannot derive an inverse from a checkpoint or a string preimage.
    laws: Object.freeze({ invertible: false, coalescible: true, idempotent: false, commutativeMerge: true }),
    validate(value: unknown, descriptor?: FieldDescriptor) {
      if (descriptor?.type === 'raster') {
        if (value === null || value === undefined) return true;
        if (Buffer.isBuffer(value)) return true;
        if (typeof value === 'string') return true;
        return 'expected a raster value (Buffer, string, or null)';
      }
      if (descriptor?.type === 'polyline') {
        if (value === null || value === undefined) return true;
        if (Array.isArray(value)) return true;
        return 'expected a polyline value (array or null)';
      }
      return 'text.crdt accepts native operations only';
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown, descriptor?: FieldDescriptor) {
      if (descriptor?.type === 'raster' || descriptor?.type === 'polyline') {
        return Object.is(previous, next) ? null : { set: next };
      }
      throw new Error('text.crdt has no whole-value diff; dispatch Entity.field.apply instead');
    },
  }),

  // `store` — an internally-keyed owned collection (map). diff is a membership
  // delta: {added, removed, changed}. A role change is `changed`, NOT `added` —
  // only a NEW member fires native added (idempotent re-share, DECISIONLOG #57).
  store: Object.freeze({
    laws: Object.freeze({ invertible: true, coalescible: true, idempotent: true, commutativeMerge: false }),
    validate(value: unknown) {
      if (value === null || typeof value !== 'object') return 'expected a store value';
      return true;
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown) {
      return storeMapDiff(previous, next);
    },
  }),

  // `ordered` — a fractional-index keyspace (list). Ordered has NO `strategy.diff`:
  // its delta contract is the native identity-keyed per-op EVENTS emitted by
  // orderedMutateHandlers (`.inserted`/`.moved`/`.reordered`/`.removed`, each
  // carrying the stable element `id` + the fractional `key`), normalized under
  // `delta:{[field]:event.data}` in live.mjs (P6e-1b B2). A whole-list snapshot
  // diff is the wrong shape for a fractional-index keyspace — `key` is a volatile
  // sort position that changes on every insert/move, so a snapshot-diff would
  // reinvent the per-op events from the wrong input shape ({key,...} objects vs the
  // side-table's `(id,key,item)` rows). Ordered is intrinsically per-op-identity,
  // not whole-state-snapshot. `validate` ensures the payload is an array;
  // `apply` replaces (single-writer dispatch — the side-table is the authority,
  // mutated by the native events' projection, not by an `.updated` main-column
  // write). SPEC §5.3 names ordered's "diff + index + inverse machinery" — that
  // machinery is the operation API (insertAt/move/reorder/remove) + the events it
  // dispatches, NOT a `strategy.diff` function. computeDelta's DIFF_ELIGIBLE set
  // (field-delta.mjs) structurally enforces that ordered never reaches this
  // strategy's (absent) `.diff` (DECISIONLOG #74 — VESTIGIAL: deleted orderedListDiff).
  ordered: Object.freeze({
    laws: Object.freeze({ invertible: true, coalescible: false, idempotent: false, commutativeMerge: false }),
    validate(value: unknown) {
      if (!Array.isArray(value)) return 'expected an ordered list';
      return true;
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
  }),

  // `computed` — a computed field. `computed()` is read-time only and never
  // reaches this persistence strategy; `computed.stored()` stores a JSON cell
  // written by the projection.
  computed: Object.freeze({
    laws: Object.freeze({ invertible: false, coalescible: true, idempotent: false, commutativeMerge: false }),
    validate() {
      return true; // the compute result is trusted, not client-provided
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown) {
      if (Object.is(previous, next)) return null;
      return { set: next };
    },
    serialize(value: unknown) {
      if (value === null || value === undefined) return value;
      return JSON.stringify(value);
    },
    deserialize(value: unknown) {
      if (value === null || value === undefined) return value;
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    },
  }),

  // `projected` — a stored computed field updated by a post-commit projection.
  projected: Object.freeze({
    laws: Object.freeze({ invertible: false, coalescible: true, idempotent: false, commutativeMerge: false }),
    validate() {
      return true;
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown) {
      if (Object.is(previous, next)) return null;
      return { set: next };
    },
    serialize(value: unknown) {
      if (value === null || value === undefined) return value;
      return JSON.stringify(value);
    },
    deserialize(value: unknown) {
      if (value === null || value === undefined) return value;
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    },
  }),

  // `struct` — a namespace of named value sub-cells (the `link` field is the
  // first instance). The struct does not store a value of its own; it stores
  // ONE flat cell per declared sub-cell. diff is a PER-SUB-CELL delta — only
  // changed sub-cells appear in `cells` (an unchanged sub-cell is absent). The
  // Phase 1 write path flattens a struct payload into per-cell columns via
  // flattenStruct; serialize/apply of the WHOLE struct replace it.
  struct: Object.freeze({
    laws: Object.freeze({ invertible: true, coalescible: true, idempotent: false, commutativeMerge: false }),
    validate(value: unknown, descriptor?: FieldDescriptor) {
      if (value === null || value === undefined) return true;
      if (typeof value !== 'object') return 'expected a structured value';
      const valueRecord = value as Record<string, unknown>;
      const cells = descriptor?.cells ?? {};
      // every supplied sub-key must be a declared, stored sub-cell (fail closed)
      for (const key of Object.keys(valueRecord)) {
        if (!Object.prototype.hasOwnProperty.call(cells, key)) {
          return `'${key}' is not a stored sub-cell of this structured field`;
        }
        const structural = STRATEGIES[cells[key].kind].validate(valueRecord[key], cells[key]);
        if (structural !== true) return `${key}: ${structural}`;
      }
      return true;
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown, descriptor?: FieldDescriptor) {
      return structDiff(previous, next, descriptor);
    },
  }),

  // `state` — a finite-state-machine field: a closed domain of string values plus
  // a declared legal-transition graph. validate checks membership in the declared
  // values set. diff reports `{ from, to }` on change (never a whole-value set).
  // apply replaces. No serialize needed (the value is already a domain string).
  // The transition guard (reject illegal moves at update time) lives in the CRUD
  // handler — this strategy validates shape only.
  state: Object.freeze({
    laws: Object.freeze({ invertible: true, coalescible: true, idempotent: true, commutativeMerge: false }),
    validate(value: unknown, descriptor?: FieldDescriptor) {
      const values = descriptor?.values ?? [];
      if (!values.includes(value)) {
        return `expected one of [${values.join(', ')}]`;
      }
      return true;
    },
    apply(_previous: unknown, next: unknown) {
      return next;
    },
    diff(previous: unknown, next: unknown) {
      if (previous === next) return null;
      return { from: previous, to: next };
    },
  }),
});

// ---------------------------------------------------------------------------
// The storage-shape authority.
//
// DDL generation, the ownership census, schema-owned entity-table validation,
// and generated app types all need the SAME answer to three questions: which
// field kinds contribute a main-table column, what SQL type that column has,
// and which columns a declared field contributes. These helpers are that ONE
// authority — the mirrors that used to live in ddl.ts / schema-census.ts /
// schema-entity-validation.ts / generate-types.ts now call them.
// ---------------------------------------------------------------------------

// kind → the discriminator values DDL accepts. For the two mode-only kinds the
// set holds MODES (there is no `type`). The non-strategy kinds are listed here
// explicitly so a kind can never be accepted by DDL while being silently
// unsupported at runtime: ephemeral engages the pace seam (side-table cell, no
// persistence strategy); annotatedText owns its own DDL (no strategy).
export const SUPPORTED_FIELD_TYPES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  value: Object.freeze(new Set(['text', 'boolean', 'date', 'number', 'json', 'vector', 'ref'])),
  crdt: Object.freeze(new Set(['text', 'raster', 'polyline'])),
  hash: Object.freeze(new Set(['hash'])),
  store: Object.freeze(new Set(['map', 'log'])),
  ordered: Object.freeze(new Set(['list'])),
  ephemeral: Object.freeze(new Set(['ephemeral'])),
  state: Object.freeze(new Set(['state'])),
  struct: Object.freeze(new Set(['link'])),
  annotatedText: Object.freeze(new Set(['annotatedText'])),
  computed: Object.freeze(new Set(['pull', 'stored'])),
  projected: Object.freeze(new Set(['async'])),
});

export const MODE_ONLY_FIELD_KINDS: ReadonlySet<string> = Object.freeze(new Set(['computed', 'projected']));

// DDL accepts these kinds but they have NO entry in STRATEGIES — their storage
// is owned by a seam other than the field strategy table (documented above).
export const NON_STRATEGY_FIELD_KINDS: ReadonlySet<string> = Object.freeze(new Set(['ephemeral', 'annotatedText']));

// Load-time invariant: the DDL authority and the strategy table cannot drift.
// Every strategy-backed kind must be accepted by DDL, and every DDL-accepted
// kind must be either strategy-backed or an explicitly documented non-strategy
// storage seam. Fail closed (throw at module load) if someone adds one side.
{
  const accepted = new Set(Object.keys(SUPPORTED_FIELD_TYPES));
  for (const kind of Object.keys(STRATEGIES)) {
    if (!accepted.has(kind)) {
      throw new Error(`storage-shape authority is missing strategy-backed kind '${kind}'`);
    }
  }
  for (const kind of accepted) {
    if (!Object.hasOwn(STRATEGIES, kind) && !NON_STRATEGY_FIELD_KINDS.has(kind)) {
      throw new Error(
        `storage-shape authority accepts '${kind}' with neither a strategy nor a documented non-strategy storage seam`,
      );
    }
  }
}

// The loose shape every storage derivation reads. Field descriptors from
// field.ts and the compiled entity carry more, but these are the only keys the
// storage decision consults.
export interface StorageShapeDescriptor {
  readonly kind?: string | undefined;
  readonly type?: string | undefined;
  readonly mode?: string | undefined;
  readonly cells?: Readonly<Record<string, unknown>> | undefined;
  readonly nullable?: boolean | undefined;
  readonly optional?: boolean | undefined;
}

// Validate a descriptor against the authority. Returns the REASON (without a
// field location) or null; the DDL layer adds `at Entity.field` for context.
export function fieldShapeError(descriptor: StorageShapeDescriptor | null | undefined): string | null {
  if (descriptor === null || typeof descriptor !== 'object') return 'invalid field descriptor';
  const kind = descriptor.kind;
  const supported = kind === undefined ? undefined : SUPPORTED_FIELD_TYPES[kind];
  if (supported === undefined) return `unknown field kind '${String(kind)}'`;
  if (MODE_ONLY_FIELD_KINDS.has(kind!)) {
    const mode = descriptor.mode;
    if (mode === undefined || !supported.has(mode)) return `unknown ${kind} field mode '${String(mode)}'`;
    return null;
  }
  const type = descriptor.type;
  if (type === undefined || !supported.has(type)) return `unknown ${kind} field type '${String(type)}'`;
  return null;
}

// Kinds whose value lives in ONE main-table column named after the field.
// `struct` is NOT here: it contributes one column per declared cell instead
// (storedColumnsOf). `computed` qualifies only in its `stored` mode.
export const STORED_FIELD_KINDS: ReadonlySet<string> = Object.freeze(
  new Set(['value', 'crdt', 'hash', 'state', 'projected', 'computed']),
);

export function isMainTableField(descriptor: StorageShapeDescriptor | null | undefined): boolean {
  const kind = descriptor?.kind;
  if (kind === 'computed') return descriptor?.mode === 'stored';
  return kind !== undefined && STORED_FIELD_KINDS.has(kind);
}

// SQLite column type for a stored field. Decided by the value type, never by
// the kind: every kind that reaches this helper has already been checked
// against SUPPORTED_FIELD_TYPES by fieldShapeError.
export function sqlTypeOf(descriptor: StorageShapeDescriptor): 'INTEGER' | 'REAL' | 'TEXT' {
  switch (descriptor.type) {
    case 'boolean':
    case 'date':
      return 'INTEGER';
    case 'number':
      return 'REAL';
    default:
      return 'TEXT';
  }
}

export interface StoredColumn {
  readonly name: string;
  readonly type: 'INTEGER' | 'REAL' | 'TEXT';
}

// The main-table column(s) one declared field contributes. Struct fields
// flatten into their per-cell columns; every other stored field has one column
// named after the field. Non-stored kinds (side tables, pull-computed,
// ephemeral, annotatedText) contribute nothing.
export function storedColumnsOf(fieldName: string, descriptor: StorageShapeDescriptor | null | undefined): readonly StoredColumn[] {
  if (!descriptor) return [];
  if (descriptor.kind === 'struct') {
    return Object.freeze(
      Object.keys(descriptor.cells ?? {}).map((cell) =>
        Object.freeze({ name: structCellColumn(fieldName, cell), type: 'TEXT' as const })),
    );
  }
  if (!isMainTableField(descriptor)) return [];
  return Object.freeze([Object.freeze({ name: fieldName, type: sqlTypeOf(descriptor) })]);
}

// The public TS type of a stored value (generated row types). Kept beside the
// storage mapping so a new value type cannot be added to DDL without also
// being represented in the generated surface.
export function storedValueTsType(descriptor: StorageShapeDescriptor): 'boolean' | 'number' | 'string' {
  switch (descriptor.type) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    default: return 'string';
  }
}

// The generated column name for a structured field's sub-cell. Derived from the
// declared shape (no magic strings): `<field>__<cell>`. The double underscore is
// a visibly-generated separator; a load-time guard (entity compiler) forbids a
// declared field/cell name containing it, so the generated name never collides
// with a hand-declared field. This ONE function is the sole authority on the
// name — the scope handle, the write path, and hydration all derive through it.
export function structCellColumn(fieldName: string, cellName: string) {
  return `${fieldName}__${cellName}`;
}

// Flatten a struct payload value into its per-cell stored columns. Used by the
// write path so a single declared struct field becomes several flat columns.
// Only declared sub-cells are emitted (validateMutation already rejected any
// undeclared sub-key); each cell is serialized by its own value strategy.
export function flattenStruct(fieldName: string, descriptor: FieldDescriptor, value: unknown): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  if (value === null || value === undefined) return cells;
  const valueRecord = value as Record<string, unknown>;
  for (const [cellName, cellDescriptor] of Object.entries(descriptor.cells ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(valueRecord, cellName)) continue;
    cells[structCellColumn(fieldName, cellName)] = serializeField(cellDescriptor, valueRecord[cellName]);
  }
  return cells;
}

// Resolve a field's strategy by its kind. An unknown kind fails closed — there is
// no silent default strategy (the kind names the contract; an unknown kind is a
// declaration error).
export function resolveStrategy(kind: string): FieldStrategy {
  if (NON_STRATEGY_FIELD_KINDS.has(kind)) {
    throw new Error(
      `${kind} fields do not use a persistence strategy — ` +
        `${kind === 'ephemeral' ? 'they engage the pace seam, not the persist seam' : 'they own their DDL in annotated-text-field.ts'}`,
    );
  }
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new Error(
      `unknown field kind '${kind}'. The field kinds are: ` +
        `${Object.keys(SUPPORTED_FIELD_TYPES).sort().join(', ')}.`,
    );
  }
  return strategy;
}

// lawsOf(kind) → the field kind's declared algebraic laws. Used by undo (checks
// invertible before dispatching an inverse), log compaction (coalescible gates
// coalescing), and future derivation consumers. Laws are frozen, per-kind, and
// never per-instance — the kind owns its algebra, not individual descriptors.
export function lawsOf(kind: string): StrategyLaws {
  return resolveStrategy(kind).laws;
}

// Serialize a single value to the stored cell its descriptor's kind dictates.
// Resolves the descriptor's strategy and defers to its `serialize` (the value
// kind owns the boolean→1/0, Date→epoch mapping). A kind whose strategy has no
// serialize (Phase 2 merge kinds, never baked into a scope literal in Phase 1)
// passes the value through. This is the seam the scope compiler calls to bake a
// literal (fields.x.is(v)) into a bindable param, and the write path will call to
// store a cell — one mapping, two callers (singular system).
export function serializeField(descriptor: FieldDescriptor, value: unknown): unknown {
  const strategy = resolveStrategy(descriptor.kind);
  if (typeof strategy.serialize !== 'function') return value;
  return strategy.serialize(value, descriptor);
}

// Deserialize a stored cell back into the public row value owned by its field
// strategy. Most stored cells are already public values; json is the first
// value-kind type that needs a read-side mapping from TEXT back to object/array.
export function deserializeField(descriptor: FieldDescriptor, value: unknown): unknown {
  const strategy = resolveStrategy(descriptor.kind);
  if (typeof strategy.deserialize !== 'function') return value;
  return strategy.deserialize(value, descriptor);
}

// hashPasswordAsync(plaintext) — non-blocking password hashing using promisified
// crypto.scrypt. Produces the prefixed native `scrypt:saltHex:digestHex` format
// so verification never falls through to legacy better-auth scrypt on mismatch.
export async function hashPasswordAsync(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scryptAsync(plaintext, salt, 64);
  return `${NATIVE_SCRYPT_PREFIX}${salt.toString('hex')}:${digest.toString('hex')}`;
}

// verifyHash(candidate, stored) — the one-way check behind a hydrated hash
// field's `.verify(plaintext)`. Recomputes scrypt over the candidate with the
// stored salt and compares in constant time. Fail closed: a missing/malformed
// stored cell, or a non-string candidate, is `false` (never a thrown 500 on the
// login path, never a permissive default).
//
// Format gating: prefixed `scrypt:<saltHex>:<digestHex>` hashes execute exactly
// one native scrypt run and never fall back to better-auth's legacy profile.
// Only unprefixed legacy `hexSalt:hexDigest` cells are eligible for the
// better-auth fallback.
export function verifyHash(candidate: unknown, stored: unknown): boolean {
  if (typeof candidate !== 'string' || typeof stored !== 'string') return false;
  if (stored.startsWith(NATIVE_SCRYPT_PREFIX)) {
    const parsed = parsePrefixedNativeHash(stored);
    if (!parsed) return false;
    const actual = scryptSync(candidate, parsed.salt, parsed.expected.length);
    return timingSafeEqual(actual, parsed.expected);
  }
  const legacy = parseLegacyHexHash(stored);
  if (!legacy) return false;
  const actual = scryptSync(candidate, legacy.salt, legacy.expected.length);
  if (timingSafeEqual(actual, legacy.expected)) return true;

  return tryBetterAuthHash(candidate, stored, legacy.expected);
}

// verifyHashAsync(candidate, stored) — non-blocking counterpart to verifyHash
// using promisified crypto.scrypt so login routes do not block the event loop.
export async function verifyHashAsync(candidate: unknown, stored: unknown): Promise<boolean> {
  if (typeof candidate !== 'string' || typeof stored !== 'string') return false;
  if (stored.startsWith(NATIVE_SCRYPT_PREFIX)) {
    const parsed = parsePrefixedNativeHash(stored);
    if (!parsed) return false;
    const actual = await scryptAsync(candidate, parsed.salt, parsed.expected.length);
    return timingSafeEqual(actual, parsed.expected);
  }
  const legacy = parseLegacyHexHash(stored);
  if (!legacy) return false;
  const actual = await scryptAsync(candidate, legacy.salt, legacy.expected.length);
  if (timingSafeEqual(actual, legacy.expected)) return true;

  const legacyDigest = await scryptAsync(
    candidate.normalize('NFKC'),
    legacy.saltHex,
    legacy.expected.length,
    {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 128 * 16384 * 16 * 2,
    },
  );
  return timingSafeEqual(legacyDigest, legacy.expected);
}

export const verifyAsync = verifyHashAsync;

// Pipeline stage 1 — validate. Runs each payload key against the field-option
// rules the payload itself can decide (readonly, required-clear), then its
// structural strategy check, then its declared `validate` (if any). The first
// failure throws a ValidationError naming `Entity.field` + the reason; a payload
// key that is not a declared field fails closed. Fields absent from the payload
// are untouched (partial update). Returns a canonicalized payload on success so
// the stage composes left-to-right in the pipeline.
//
// Field-option ownership by SEAM (the smallest seam that can decide the rule):
//  - `readonly` is an untrusted-payload rule: a client may not set/change the
//    field at all (the framework fills it server-side). Enforced HERE — this seam
//    already sees the untrusted payload.
//  - `required` is a final-record invariant; the part visible to the payload is
//    "may not be explicitly cleared". Enforced HERE for the clear case. Final
//    requiredness on create (supplied by payload OR route OR principal OR default)
//    is the write path's job (Phase 2), where all sources are merged.
//  - `default` is materialization, not validation — it belongs to the write/apply
//    path (Phase 2), never to this accept/reject seam.
function validateFieldValue(entityName: string, key: string, descriptor: FieldDescriptor, value: unknown): unknown {
  if (descriptor.type === 'text' && typeof descriptor.canonicalize === 'function' && value !== null && value !== undefined) {
    value = descriptor.canonicalize(value);
  }
  if (descriptor.required === true && (value === null || value === undefined)) {
    throw new ValidationError(
      `${entityName}.${key} is required and may not be cleared (set to null).`,
    );
  }
  // Absence (`undefined`) and explicit `null` are separate concepts. `optional`
  // permits absence; only an explicit opt-in permits a client to write a NULL
  // cell. `nullable: true` is that opt-in; `default: null` declares the field's
  // materialized value IS null, so a client may reaffirm that value too. A plain
  // optional scalar stays non-nullable (fail closed — see #237).
  if (value === null && (descriptor.nullable === true || descriptor.default === null)) return value;

  const { validate } = resolveStrategy(descriptor.kind);
  const structural = validate(value, descriptor);
  if (structural !== true) {
    throw new ValidationError(`${entityName}.${key}: ${structural}`, structural.includes('.') ? { code: structural } : undefined);
  }
  if (typeof descriptor.validate === 'function') {
    const declared = descriptor.validate(value);
    if (declared !== true) {
      const reason = typeof declared === 'string' ? declared : 'failed validate';
      throw new ValidationError(`${entityName}.${key}: ${reason}`);
    }
  }
  return value;
}

export function validateMaterializedField(entityRecord: EntityRecord, key: string, value: unknown): unknown {
  const descriptor = entityRecord.fields[key];
  if (!descriptor) throw new ValidationError(`${entityRecord.name}.${key} is not a declared field.`);
  return validateFieldValue(entityRecord.name, key, descriptor, value);
}

export function validateMutation(entityRecord: EntityRecord, payload: Record<string, unknown>): Record<string, unknown> {
  const { name, fields } = entityRecord;
  const transformed: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(payload)) {
    const descriptor = fields[key];
    if (!descriptor) {
      throw new ValidationError(
        `${name}.${key} is not a declared field. A mutation may only touch ` +
          `declared fields (fail closed).`,
      );
    }


    // readonly: the field's mere presence in an untrusted payload is rejected —
    // the client cannot set it; the framework assigns it server-side.
    if (descriptor.kind === 'computed') {
      throw new ValidationError(
        `${name}.${key} is a computed field and may not be set by the client.`,
      );
    }

    if (descriptor.readonly === true || descriptor.touch === true) {
      throw new ValidationError(
        `${name}.${key} is ${descriptor.touch ? 'a touch field' : 'readonly'}: a client may not set or ` +
          `change it. It is assigned server-side${descriptor.touch ? ' on every mutation' : ''}.`,
      );
    }

    // map fields cannot be written via create/update payload — they are
    // membership collections that must be mutated through the row handle
    // (row.<field>.set(...)/.remove(...)). Accepting a map payload would
    // try to store an object literal as a main-table cell (fail closed).
    if (descriptor.kind === 'store' && descriptor.type === 'map') {
      throw new ValidationError(
        `${name}.${key} is a map field and cannot be set via payload. ` +
          `Mutate it through the row handle: row.${key}.set(memberId, { role }).`,
      );
    }

    // required: the payload may not explicitly CLEAR a required field. (Whether a
    // required field is present at all on create is the write path's concern.)
    transformed[key] = validateFieldValue(name, key, descriptor, value);
  }
  return transformed;
}
