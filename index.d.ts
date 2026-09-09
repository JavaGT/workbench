/// <reference types="node" />

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { SearchPlugin, SearchPluginRegistry } from './src/server.js';

export interface WorkbenchStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface WorkbenchDatabase {
  prepare(sql: string): WorkbenchStatement;
  exec(sql: string): void;
  txn?<T>(fn: () => Promise<T>): Promise<T>;
  begin?(): void;
  commit?(): void;
  rollback?(): void;
  upsert?(options: {
    table: string;
    keyColumns: string[];
    columns?: string[];
    values: Record<string, unknown>;
  }): void;
}

export type ProjectPurgeDisposition =
  | { readonly kind: 'project-purge-root'; readonly projectKey: string }
  | { readonly kind: 'project-purge-dependent'; readonly parent: string; readonly foreignKey: string }
  | { readonly kind: 'retained'; readonly reason: string }
  | { readonly kind: 'schema-only' };
export interface OwnedResources {
  purgeProject(projectId: string): Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export type PrincipalType = 'user' | 'link' | 'system' | 'apiKey' | 'anonymous';

// The closed principal-status union (S5/A1). Defaults to `'active'`; the
// non-active statuses express disabled/expired/revoked without minting a new
// principal type per state. Admission is two-valued: only `'active'` principals
// are admitted; the A2 seam collapses any non-active principal to `anonymous`
// before calling into row/field gates, so the admission surface never exposes
// which non-active status applied. `statusOf()` is the audit/diagnostic reader.
export type PrincipalStatus = 'active' | 'disabled' | 'expired' | 'revoked';

export interface Principal {
  readonly type: PrincipalType;
  readonly id: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly status: PrincipalStatus;
}

export type FailureCategory =
  | 'invalid-input'
  | 'denied'
  | 'unknown-action'
  | 'not-found'
  | 'conflict'
  | 'internal';

export const FAILURE_CATEGORIES: readonly [
  'invalid-input',
  'denied',
  'unknown-action',
  'not-found',
  'conflict',
  'internal',
];

export interface WorkbenchFailure {
  readonly category: FailureCategory;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface FailureOutcome {
  readonly ok: false;
  readonly failure: WorkbenchFailure;
}

export interface ForbiddenError extends Error {
  readonly status: 403;
  readonly code?: string;
  readonly failure: WorkbenchFailure;
}

export function failure(
  category: FailureCategory,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): WorkbenchFailure;
export function failureOutcome(workbenchFailure: WorkbenchFailure): FailureOutcome;
export function forbidden(message?: string, code?: string): ForbiddenError;
export function isWorkbenchFailure(value: unknown): value is WorkbenchFailure;
export function sanitizeUnexpectedFailure(value?: unknown): WorkbenchFailure;
export function statusForFailure(failure: WorkbenchFailure): 400 | 403 | 404 | 409 | 500;

export interface UserPrincipal extends Principal {
  readonly type: 'user';
  readonly id: string;
}

export function principal(options: {
  type: 'user';
  id: string;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
}): UserPrincipal;
export function principal(options?: {
  type?: PrincipalType;
  id?: string | null;
  attributes?: Record<string, unknown>;
  status?: PrincipalStatus;
}): Principal;
export const anonymous: Principal;

// The REAL principal status — the audit/diagnostic reader. Admission callers
// (the A2 seam) collapse any non-'active' principal to `anonymous` BEFORE
// calling into row/field gates; they never key a decision off this.
export function statusOf(principal: Principal): PrincipalStatus;

// The two-valued admission collapse (S5/A1), applied AT the admission boundary
// (the route-gate/serve seam): a non-'active' principal becomes the canonical
// `anonymous`, so a revoked and an unauthenticated caller are indistinguishable
// to admission; an 'active' principal passes through unchanged. The real status
// stays on the original principal for statusOf().
export function collapseForAdmission(principal: Principal): Principal;

// The attributable machine/system principal (S5/A5). Operational work — the
// schedule clock dispatch, the job-queue worker, and a consuming app's
// operational runtime — runs under a machinePrincipal: a `system` identity with
// a stable id and an EXPLICIT granted operation allowlist. It can never mint
// `user`, and its attributes are derived ONLY from { id, operations } (frozen),
// so it cannot carry attributes that satisfy a human identity check. An
// operation outside the allowlist is denied (fail closed); "internal" is never
// an implicit grant.
export interface MachinePrincipal extends Principal {
  readonly type: 'system';
  readonly id: string;
  readonly attributes: Readonly<{
    source: string;
    machine: true;
    operations: readonly string[];
  }>;
}

export function machinePrincipal(options: {
  id: string;
  operations: readonly string[];
}): MachinePrincipal;
export function isMachinePrincipal(value: unknown): value is MachinePrincipal;
export function machineAllows(
  principal: Principal | null | undefined,
  operation: string | { readonly operation: string } | null | undefined,
): boolean;
export function machineOperations(principal: Principal | null | undefined): readonly string[] | null;

// Raised by principal() when a status outside the closed union is declared
// (fail closed, sibling to the type-union error).
export class UnknownPrincipalStatusError extends Error {
  constructor(message: string);
}

// The stable operation-category vocabulary (S5/A1): frozen identity tokens the
// same discipline as the grant capabilities. `operationCategory(verb)`
// normalizes any verb or category name to its token; an unknown name throws
// (including an inherited Object.prototype name). `deleteOp` is the canonical
// identifier for the 'delete' category (`delete` is a reserved word); `delete`
// and `blob-read` are exported as aliases of the same tokens.
export const operations: {
  readonly read: OperationCategory;
  readonly subscribe: OperationCategory;
  readonly create: OperationCategory;
  readonly update: OperationCategory;
  readonly deleteOp: OperationCategory;
  readonly delete: OperationCategory;
  readonly execute: OperationCategory;
  readonly search: OperationCategory;
  readonly blobRead: OperationCategory;
  readonly 'blob-read': OperationCategory;
  readonly administrative: OperationCategory;
  readonly OPERATION_CATEGORIES: readonly OperationCategory[];
  operationCategory(verb: string): OperationCategory;
};
export interface OperationCategory {
  readonly operation: string;
}

// The authorization adapter seam (S5/A2) — the injectable AUTHORIZATION half
// of the auth/authz split. REST CRUD dispatch, the route gate, and composite
// (registered) actions all consult ONE adapter instance; an app passes its own
// via `listen(port, { authorization })` to swap the policy engine without
// touching HTTP, sockets, or DB state. The vocabulary is generic — never app
// nouns. Admission is two-valued: a non-'active' principal collapses to
// `anonymous` before any row/field gate runs, so a revoked and an unknown
// principal are indistinguishable on the decision surface (no status oracle).
export type ResourceCategory =
  | 'entity'
  | 'blob'
  | 'search'
  | 'action'
  | 'subscription'
  | 'principal'
  | 'policy';

export type AdmissionReasonCode =
  | 'anonymous'
  | 'principal-status'
  | 'no-row-scope'
  | 'no-capability'
  | 'no-field-access'
  | 'no-resource'
  | 'unknown-category'
  | 'unknown-operation'
  | 'policy-error';

export interface DecisionTraceEntry {
  readonly check: string;
  readonly outcome: boolean;
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  /** Null ONLY on an 'unknown-operation' denial — an unrecognized operation is not a category. */
  readonly operation: OperationCategory | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId: string | null;
  readonly reasonCode: AdmissionReasonCode | null;
  readonly capabilities: readonly Capability[];
  /** Dev-only diagnostic (env WORKBENCH_AUTH_TRACE=1 or the trace option); null in production. */
  readonly trace: readonly DecisionTraceEntry[] | null;
}

export interface EntityAdmitInput {
  readonly category: 'entity';
  readonly verb: string;
  readonly principal: Principal;
  readonly entity: unknown;
  readonly row: unknown;
  readonly operation?: OperationCategory | string;
  readonly fieldName?: string;
  readonly capability?: Capability;
  readonly resourceId?: string | null;
}

export interface PrincipalAdmitInput {
  readonly category: 'principal';
  readonly principal: Principal;
  readonly operation?: OperationCategory | string;
  readonly gate?: Gate;
  readonly resourceId?: string | null;
}

export interface RowRequirement {
  readonly entity: unknown;
  readonly verb: string;
  readonly row: unknown;
  readonly capability?: Capability;
}

export interface ActionAdmitInput {
  readonly category: 'action';
  readonly principal: Principal;
  readonly requirements: readonly RowRequirement[];
  readonly operation?: OperationCategory | string;
  readonly resourceId?: string | null;
}

export interface ResourceAdmitInput {
  readonly category: 'blob' | 'search' | 'subscription' | 'policy';
  readonly principal: Principal;
  readonly operation?: OperationCategory | string;
  readonly resourceName?: string;
  /** The row in STORED cell form (the shape SQL returns); for a named registered resource, admit() re-verifies it against the registered scope. */
  readonly row?: unknown;
  readonly resourceId?: string | null;
}

export type AdmitInput = EntityAdmitInput | PrincipalAdmitInput | ActionAdmitInput | ResourceAdmitInput;

export interface ResourceRegistration {
  readonly category: 'blob' | 'search' | 'subscription' | 'policy';
  readonly name: string;
  readonly scope: (context: { readonly is: unknown; readonly fields: unknown }) => unknown;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly checks?: Readonly<Record<string, (context: unknown) => boolean>>;
}

export interface AuthorizationAdapter {
  /** Decide admission for one operation on one resource; frozen decision. */
  admit(input: AdmitInput): Promise<AdmissionDecision>;
  /** Register a non-entity resource; a non-compilable scope throws here, never at query time. */
  registerResource(input: ResourceRegistration): void;
}

export interface AuthorizationAdapterOptions {
  trace?: boolean;
  mayRow?: (entity: unknown, verb: string, row: unknown, principal: Principal) => Promise<boolean>;
  mayVerb?: (entity: unknown, verb: string, row: unknown, principal: Principal) => Promise<boolean>;
  fieldCapabilities?: (entity: unknown, fieldName: string, row: unknown, principal: Principal) => Promise<{ granted: boolean; capabilities: readonly Capability[] }>;
}

export function createAuthorizationAdapter(options?: AuthorizationAdapterOptions): AuthorizationAdapter;

// ── generic audit contract (S5/A4) ───────────────────────────────────────────
// ONE event schema, TWO retention classes, injectable sink, and the rate-limited
// denial path. IDs are OPAQUE, never content: every string recorded on an event
// (actor.id, resourceId, operation) is canonicalized at the emitter boundary via
// sanitizeOpaqueId, so a token, alias, filename, excerpt, or URL can never ride
// the record. `retentionConfig` values pass through untouched as a frozen
// snapshot taken at construction (shallow copy).

/** An opaque identifier: a bounded, whitespace-free lowercase token of letters/digits/`-`/`_` (never a URL, path, email alias, excerpt, or token-like string). */
export type OpaqueId = string;
/** Validation for the opaque-id shape — bounded, whitespace-free, lowercase-only token. */
export function isOpaqueId(value: string): boolean;
/** Emitter-boundary canonicalizer: passes conforming ids through, maps everything else to a deterministic sha256 digest; empty/null → null. Idempotent. */
export function sanitizeOpaqueId(value: string | null | undefined): string | null;

export type AuditClassification = 'security' | 'diagnostic';
export type AuditOutcome = 'allow' | 'deny';

export interface AuditActor {
  readonly type: PrincipalType;
  readonly id: string | null;
  readonly status: PrincipalStatus;
}
/** Membership privilege accounting detail: subject + role delta, opaque-canonicalized like every id (#691). */
export interface AuditMembershipDetail {
  readonly kind: 'membership';
  readonly subjectId: string | null;
  readonly roleBefore: string | null;
  readonly roleAfter: string | null;
}
export type AuditEventDetail = AuditMembershipDetail;
export interface AuditEvent {
  readonly id: string;
  readonly time: number;
  readonly actor: AuditActor;
  readonly operation: string | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode: AdmissionReasonCode | null;
  readonly classification: AuditClassification;
  readonly detail?: AuditEventDetail | null;
}
export type AuditRetention = string;
export interface RetentionConfig {
  readonly security: AuditRetention;
  readonly diagnostic: AuditRetention;
}
export interface AuditInput {
  readonly principal: Principal;
  readonly operation: OperationCategory | string | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId?: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: AdmissionReasonCode | null;
  readonly detail?: AuditEventDetail | null;
}
export interface AuditSink {
  write(event: AuditEvent, retention: AuditRetention): void;
}
export interface AuditorOptions {
  readonly sink?: AuditSink;
  readonly sinks?: Partial<Record<AuditClassification, AuditSink>>;
  /** Value passthrough with snapshot semantics: shallow-copied and frozen at construction. */
  readonly retentionConfig: RetentionConfig;
  readonly now?: () => number;
  readonly id?: () => string;
}
export interface Auditor {
  readonly retentionConfig: RetentionConfig;
  auditSecurity(input: AuditInput): AuditEvent;
  auditDiagnostic(input: AuditInput): AuditEvent;
}
export function createAuditor(options: AuditorOptions): Auditor;
export const noopAuditSink: AuditSink;

export interface DenialInput {
  readonly principal: Principal;
  readonly operation: OperationCategory | string | null;
  readonly resourceCategory: ResourceCategory;
  readonly resourceId?: string | null;
  readonly reasonCode: AdmissionReasonCode;
}
export interface DenialAuditorOptions {
  readonly auditor: Auditor;
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly limiter?: KeyedRateLimiter;
}
export interface DenialAuditor {
  readonly windowMs: number;
  auditDenial(input: DenialInput): AuditEvent | null;
  keyOf(actor: AuditActor, reasonCode: AdmissionReasonCode): string;
}
export function createDenialAuditor(options: DenialAuditorOptions): DenialAuditor;

export interface KeyedRateLimitResult { allowed: boolean; retryAfterMs: number; limit: number; }
export interface KeyedRateLimiter { check(key: string): KeyedRateLimitResult; }
export interface KeyedRateLimitOptions { windowMs: number; max: number; now?: () => number; }
export function createKeyedRateLimiter(options?: KeyedRateLimitOptions): KeyedRateLimiter;

export interface HandlerReq {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  principal: Principal;
  raw: IncomingMessage;
  headers: IncomingMessage['headers'];
  method: string;
  url: string;
  [key: string]: unknown;
}

export interface HandlerRes {
  status(code: number): this;
  json(value: unknown): this;
  send(value?: unknown): this;
  sendStatus(code: number): this;
  render(name: string, data?: Record<string, unknown>): this;
  stream(
    response: Response | ReadableStream<Uint8Array>,
    options?: { buffering?: boolean },
  ): Promise<this>;
  raw: ServerResponse;
}

export type Handler = (
  req: HandlerReq,
  res: HandlerRes,
  next?: (error?: unknown) => void,
) => void | Promise<void>;

export type Gate = (principal: Principal) => boolean;
export function requireUser(): Gate;
export function allowAnonymous(): Gate;

export interface EntityTarget {
  readonly name: string;
}

export interface RouteBuilder {
  get(path: string, ...handlers: Array<Gate | Handler>): this;
  post(path: string, ...handlers: Array<Gate | Handler>): this;
  patch(path: string, ...handlers: Array<Gate | Handler>): this;
  delete(path: string, ...handlers: Array<Gate | Handler>): this;
  mount(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  use(path: string, target: EntityTarget | RouteBuilder | Handler): this;
}

export interface EntityRouteBuilder extends RouteBuilder {
  resource(): this;
}

/** How a declared field treats absence: required columns always project; optional ones may be missing/null. */
export type FieldMode = 'required' | 'optional';

export interface FieldDescriptor<Value = unknown, Mode extends FieldMode = 'required'> {
  readonly kind: string;
  readonly type?: string;
  readonly target?: string | WorkbenchEntity;
  readonly access?: (context: unknown) => unknown;
  can(check: (context: unknown) => unknown): FieldDescriptor<Value, Mode>;
  readonly __value?: Value;
  readonly __mode?: Mode;
  readonly [property: string]: unknown;
}

declare const queryPredicateBrand: unique symbol;
export interface QueryPredicate {
  readonly [queryPredicateBrand]: true;
}

export interface FieldHandle<Value = unknown, Key extends PropertyKey = string, Mode extends FieldMode = 'required'> {
  readonly fieldName: Key;
  /** Type-level only (never set at runtime): carries the projected value/absence mode for declaration-derived shapes. */
  readonly __value?: Value;
  readonly __mode?: Mode;
  is(value: Value): QueryPredicate;
  in(values: readonly Value[]): QueryPredicate;
  isNull(): QueryPredicate;
  gte(value: Value): QueryPredicate;
  lte(value: Value): QueryPredicate;
  matches(query: string): QueryPredicate;
}

export type EntityFields<Row extends object> = Readonly<{
  [Key in keyof Row]-?: FieldHandle<Row[Key], Key, undefined extends Row[Key] ? 'optional' : 'required'>;
}> & Readonly<{ id: FieldHandle<string, 'id'> }>;

export type FieldOptions<Value = unknown> = Readonly<{
  optional?: boolean;
  nullable?: boolean;
  readonly?: boolean;
  immutable?: boolean;
  touch?: boolean;
  default?: Value | (() => Value);
  validate?: (value: Value) => true | string;
  canonicalize?: (value: Value) => Value;
  oneOf?: readonly Value[];
  indexed?: string;
  /** Emit a SQLite foreign key and one-column index for a declaration-bound ref. */
  physical?: boolean;
  role?: string | readonly string[];
}> & Readonly<Record<string, unknown>>;

// The absence mode a declaration utility reads off an options literal: `optional`
// makes the projected key omittable; everything else projects always.
type DeclaredMode<Options> = Options extends { optional: true } ? 'optional' : 'required';
// The value a descriptor carries for an options literal: `nullable` widens the
// base value with null (a column that stores NULL projects null).
type DeclaredValue<Options, Base> = Options extends { nullable: true } ? Base | null : Base;

export interface TextFieldFactory {
  <const Options extends FieldOptions<string>>(options?: Options): FieldDescriptor<DeclaredValue<Options, string>, DeclaredMode<Options>>;
  crdt<const Options extends FieldOptions<string>>(options?: Options): FieldDescriptor<DeclaredValue<Options, string>, DeclaredMode<Options>>;
}

export const text: TextFieldFactory;
export interface AnnotatedTextAnnotationDescriptor<
  Name extends string = string,
  Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>> = Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>>,
> {
  readonly kind: 'annotation';
  readonly annotationName: Name;
  readonly appliesTo: 'text-range';
  readonly cardinality: 'many' | 'one';
  readonly fields: Readonly<Record<string, FieldDescriptor<unknown, FieldMode>>>;
  readonly actions: Actions;
  readonly empty: 'delete' | 'orphan';
}
export interface AnnotatedTextProtectingAnnotationDescriptor<
  Name extends string = string,
  Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>> = Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>>,
> {
  readonly kind: 'protectingAnnotation';
  readonly annotationName: Name;
  readonly fields: Readonly<Record<string, FieldDescriptor<unknown, FieldMode>>>;
  readonly protects: string | null;
  readonly placeholder: string;
  readonly access: ((context: { readonly is: Record<string, () => Promise<boolean>>; readonly entity: unknown; readonly annotation: unknown }) => unknown) | null;
  readonly actions: Actions;
  readonly empty: 'delete' | 'orphan';
}
export interface AnnotatedTextMeasurementDescriptor {
  readonly kind: 'measurement';
  readonly measurementName: string;
  readonly extension: string | null;
  readonly formatVersion: number;
  readonly queries: readonly string[];
}
export interface AnnotatedTextActionContribution {
  readonly fields: Readonly<Record<string, unknown>>;
}
export interface AnnotatedTextActionCurrent {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly ranges: readonly Readonly<{ start: number | null; end: number | null }>[];
}
export interface AnnotatedTextActionContext<Input extends Readonly<Record<string, FieldDescriptor>>> {
  readonly input: AnnotatedTextInputValues<Input>;
  readonly annotationId: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly selection: Readonly<{ from: number; to: number }>;
  readonly principal: Principal;
  readonly current: AnnotatedTextActionCurrent | null;
}
export interface AnnotatedTextActionDescriptor<Input extends Readonly<Record<string, FieldDescriptor>> = Readonly<Record<string, FieldDescriptor>>> {
  readonly kind: 'annotationAction';
  readonly input: Input;
  readonly authorize: ((context: Readonly<AnnotatedTextActionContext<Input>>) => boolean) | null;
  readonly change: (context: Readonly<AnnotatedTextActionContext<Input>>) => AnnotatedTextActionContribution;
}
export interface AnnotatedTextAnnotationEntityActionDescriptor<
  Input extends Readonly<Record<string, string>> = Readonly<Record<string, string>>,
> {
  readonly kind: 'annotationEntityAction';
  readonly relation: string;
  readonly project: string;
  readonly author: string;
  readonly capability: Capability<'write'>;
  readonly input: Input;
}
/** Server-side context handed to an `annotationEntityRemoveAction` invariant. The db handle is the caller's driver handle; it stays server-side and is never serialized. */
export interface AnnotatedTextAnnotationEntityRemoveContext {
  readonly db: unknown;
  readonly relatedRow: Readonly<Record<string, unknown>>;
  readonly annotationId: string;
  readonly relatedId: string;
  readonly principal: Principal | null;
}
export interface AnnotatedTextAnnotationEntityRemoveActionDescriptor {
  readonly kind: 'annotationEntityRemoveAction';
  readonly relation: string;
  readonly project: string;
  readonly author: string;
  /** The related entity's compare-and-set column (a text field; its stored cell is the compared version token). */
  readonly stale: string;
  /** Optional; when declared it must be the imported `write` capability handle. */
  readonly capability?: Capability<'write'>;
  /** Synchronous server-side policy checked atomically inside the removal transaction. Rejects by throwing; never serialized into compiled handles. */
  readonly invariant?: (context: Readonly<AnnotatedTextAnnotationEntityRemoveContext>) => void;
}
export type AnnotatedTextDeclaredActionDescriptor =
  | AnnotatedTextActionDescriptor
  | AnnotatedTextAnnotationEntityActionDescriptor
  | AnnotatedTextAnnotationEntityRemoveActionDescriptor;
export function annotation<
  Name extends string,
  Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>> = Readonly<Record<string, never>>,
>(name: Name, options?: {
  appliesTo?: 'text-range';
  cardinality?: 'many' | 'one';
  fields?: Record<string, FieldDescriptor<unknown, FieldMode>>;
  actions?: Actions;
  empty?: 'delete' | 'orphan';
  editOverlap?: 'remove' | { readonly fields: Readonly<Record<string, unknown>> };
}): AnnotatedTextAnnotationDescriptor<Name, Actions>;
export function protectingAnnotation<
  Name extends string,
  Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>> = Readonly<Record<string, never>>,
>(name: Name, options?: {
  fields?: Record<string, FieldDescriptor<unknown, FieldMode>>;
  protects?: string | null;
  placeholder?: string;
  access?: (context: { readonly is: Record<string, () => Promise<boolean>>; readonly entity: unknown; readonly annotation: unknown }) => unknown;
  actions?: Actions;
  empty?: 'delete' | 'orphan';
}): AnnotatedTextProtectingAnnotationDescriptor<Name, Actions>;
export function measurement(name: string, options?: {
  extension?: string | null;
  formatVersion?: number;
  queries?: readonly string[];
}): AnnotatedTextMeasurementDescriptor;
export type AnnotatedTextFieldValue<Descriptor> = Descriptor extends FieldDescriptor<infer Value> ? Value : unknown;
export type AnnotatedTextInputValues<Input extends Readonly<Record<string, FieldDescriptor>>> = { readonly [Name in keyof Input]: AnnotatedTextFieldValue<Input[Name]> };
export function annotationAction<Input extends Readonly<Record<string, FieldDescriptor>>>(options: {
  readonly input?: Input;
  readonly authorize?: ((context: Readonly<AnnotatedTextActionContext<Input>>) => boolean) | null;
  readonly change: AnnotatedTextActionDescriptor<Input>['change'];
}): AnnotatedTextActionDescriptor<Input>;
export function annotationEntityAction<
  Input extends Readonly<Record<string, string>>,
>(options: {
  readonly relation: string;
  readonly project: string;
  readonly author: string;
  readonly capability: Capability<'write'>;
  readonly input: Input;
}): AnnotatedTextAnnotationEntityActionDescriptor<Input>;
export function annotationEntityRemoveAction(options: {
  readonly relation: string;
  readonly project: string;
  readonly author: string;
  readonly stale: string;
  readonly capability?: Capability<'write'>;
  readonly invariant?: (context: Readonly<AnnotatedTextAnnotationEntityRemoveContext>) => void;
}): AnnotatedTextAnnotationEntityRemoveActionDescriptor;

export interface AnnotatedTextOptions {
  project: string;
  owner: string;
  annotations?: readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[];
  measurements?: readonly AnnotatedTextMeasurementDescriptor[];
  capabilities?: Readonly<Record<string, unknown>>;
  /** Names an enclosing ephemeral field/cell that owns presence carets for this document. */
  carets?: Readonly<{ field: string; cell: string }>;
}

export type AnnotatedTextAnnotationEntityActionHandle<
  Descriptor extends AnnotatedTextAnnotationEntityActionDescriptor = AnnotatedTextAnnotationEntityActionDescriptor,
> = Readonly<{
  readonly kind: 'annotationEntityAction';
  readonly family: string;
  readonly actionName: string;
  readonly entityName: string;
  readonly fieldName: string;
  readonly relation: string;
  readonly project: string;
  readonly author: string;
  readonly capability: Capability<'write'>;
  readonly input: Descriptor['input'];
}>;
export type AnnotatedTextAnnotationEntityRemoveActionHandle<
  Descriptor extends AnnotatedTextAnnotationEntityRemoveActionDescriptor = AnnotatedTextAnnotationEntityRemoveActionDescriptor,
> = Readonly<{
  readonly kind: 'annotationEntityRemoveAction';
  readonly family: string;
  readonly actionName: string;
  readonly entityName: string;
  readonly fieldName: string;
  readonly relation: string;
  readonly project: string;
  readonly author: string;
  readonly stale: Descriptor['stale'];
  readonly capability?: Capability<'write'>;
}>;
export type AnnotatedTextDomainActionHandle<
  Descriptor extends AnnotatedTextActionDescriptor = AnnotatedTextActionDescriptor,
> = Readonly<{
  readonly kind: 'annotationAction';
  readonly family: string;
  readonly actionName: string;
  readonly entityName: string;
  readonly fieldName: string;
  readonly inputNames: readonly (keyof Descriptor['input'] & string)[];
}>;
export type AnnotatedTextCompiledActionHandle<
  Descriptor extends AnnotatedTextDeclaredActionDescriptor = AnnotatedTextDeclaredActionDescriptor,
> = Descriptor extends AnnotatedTextAnnotationEntityActionDescriptor
  ? AnnotatedTextAnnotationEntityActionHandle<Descriptor>
  : Descriptor extends AnnotatedTextAnnotationEntityRemoveActionDescriptor
    ? AnnotatedTextAnnotationEntityRemoveActionHandle<Descriptor>
    : Descriptor extends AnnotatedTextActionDescriptor ? AnnotatedTextDomainActionHandle<Descriptor> : never;
export type AnnotatedTextActionHandles<
  Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>>,
> = {
  readonly [ActionName in keyof Actions]: AnnotatedTextCompiledActionHandle<Actions[ActionName]>;
};
export interface AnnotatedTextAnnotationHandle<
  Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>> = Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>>,
> {
  readonly family: string;
  readonly annotationName: string;
  readonly appliesTo: 'text-range';
  readonly cardinality: 'many' | 'one';
  readonly actions: AnnotatedTextActionHandles<Actions>;
  readonly empty: 'delete' | 'orphan';
}
export interface AnnotatedTextMeasurementHandle {
  readonly family: string;
  readonly measurementName: string;
  readonly [queryName: string]: string | (() => never);
}
export interface AnnotatedTextCapabilityHandle {
  readonly name: string;
}
export type AnnotatedTextAnnotationHandles<
  Annotations extends readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[],
> = {
  readonly [Annotation in Annotations[number] as Annotation['annotationName']]:
    Annotation extends { readonly actions: infer Actions extends Readonly<Record<string, AnnotatedTextDeclaredActionDescriptor>> }
      ? AnnotatedTextAnnotationHandle<Actions>
      : AnnotatedTextAnnotationHandle;
};
export interface AnnotatedTextFieldHandle<
  Annotations extends readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[] = readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[],
> {
  readonly fieldName: string;
  readonly annotations: AnnotatedTextAnnotationHandles<Annotations> & Readonly<Record<string, AnnotatedTextAnnotationHandle>>;
  readonly measurements: Readonly<Record<string, AnnotatedTextMeasurementHandle>>;
  readonly capabilities: Readonly<Record<string, AnnotatedTextCapabilityHandle>> | null;
}
export function annotatedText<
  Annotations extends readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[] = readonly (AnnotatedTextAnnotationDescriptor | AnnotatedTextProtectingAnnotationDescriptor)[],
>(options: AnnotatedTextOptions & { readonly annotations?: Annotations }): FieldDescriptor<AnnotatedTextFieldHandle<Annotations>>;
export interface AnnotatedTextClientEntityHandle {
  readonly name: string;
  readonly fields: Readonly<Record<string, { readonly kind: string }>>;
}
export function annotatedTextClientHandle<E extends WorkbenchEntity>(
  entity: E,
  field: AnnotatedTextFieldHandle,
): AnnotatedTextClientEntityHandle & Readonly<Record<string, unknown>>;

export function registerAnnotatedTextContract(contractName: string, contract: { readonly kind: 'measurement' | 'measurement-query' | 'event'; readonly [key: string]: unknown }): void;

export interface AnnotatedTextMeasurementValidationInput {
  readonly version: 1;
  readonly formatVersion: number;
  /** Historical name retained; whole-document text (issue #33). */
  readonly blockText: string;
  readonly payload: unknown;
}
export interface AnnotatedTextMeasurementPartitionInput extends AnnotatedTextMeasurementValidationInput {
  readonly utf16Offset: number;
}
export interface AnnotatedTextMeasurementPartitionResult {
  readonly version: 1;
  readonly leftPayload: unknown;
  readonly rightPayload: unknown;
}
/** Reserved until Workbench supports structural edit orchestration. */
export type AnnotatedTextMeasurementEditInput = unknown;
/** Reserved until Workbench supports structural edit orchestration. */
export type AnnotatedTextMeasurementEditResult = unknown;
export interface AnnotatedTextMeasurementCombineSide {
  /** Historical name retained; whole-document text (issue #33). */
  readonly blockText: string;
  readonly payload: unknown;
}
export interface AnnotatedTextMeasurementCombineInput {
  readonly version: 1;
  readonly formatVersion: number;
  /** Historical name retained; whole-document text (issue #33). */
  readonly blockText: string;
  readonly left: AnnotatedTextMeasurementCombineSide | null;
  readonly right: AnnotatedTextMeasurementCombineSide | null;
}
export interface AnnotatedTextMeasurementCombineResult {
  readonly version: 1;
  readonly payload: unknown;
}
export interface AnnotatedTextStructuralExtensionSpec {
  readonly version: 1;
  readonly validate: (input: AnnotatedTextMeasurementValidationInput) => undefined;
  readonly edit: (input: AnnotatedTextMeasurementEditInput) => AnnotatedTextMeasurementEditResult;
  readonly partition: (input: AnnotatedTextMeasurementPartitionInput) => AnnotatedTextMeasurementPartitionResult;
  readonly combine: (input: AnnotatedTextMeasurementCombineInput) => AnnotatedTextMeasurementCombineResult;
}
export function registerAnnotatedTextStructuralExtension(extensionName: string, spec: AnnotatedTextStructuralExtensionSpec): void;

/** A position in the document's single continuous text frame: an opaque
 * authoring position token plus the absolute UTF-16 offset it was issued for
 * and the placeholder-edge affinity. Block identifiers do not exist. */
export interface AnnotatedTextPosition {
  readonly positionToken: string;
  readonly offset: number;
  readonly affinity: 'left' | 'right';
}
/** The authoring binding every v9 command carries: one document-scoped
 * position frame, minted server-side from a stream + lease. */
export interface AnnotatedTextAuthoringBinding {
  readonly version: 1;
  readonly stream: string;
  readonly lease: string;
  readonly mutationId: string;
}
export interface AnnotatedTextActionAnnotation {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Annotation ids a protecting annotation restricts; admission resolves and persists them. */
  readonly protectedTargetIds?: readonly string[];
}
interface AnnotatedTextCommandBase {
  readonly id: string;
  readonly authoring: AnnotatedTextAuthoringBinding;
}
export interface AnnotatedTextInsertCommand extends AnnotatedTextCommandBase {
  readonly kind: 'text.insert';
  readonly at: AnnotatedTextPosition;
  readonly text: string;
}
export interface AnnotatedTextDeleteCommand extends AnnotatedTextCommandBase {
  readonly kind: 'text.delete';
  readonly from: AnnotatedTextPosition;
  readonly to: AnnotatedTextPosition;
}
export interface AnnotatedTextReplaceCommand extends AnnotatedTextCommandBase {
  readonly kind: 'text.replace';
  readonly from: AnnotatedTextPosition;
  readonly to: AnnotatedTextPosition;
  readonly text: string;
}
export interface AnnotatedTextApplyAnnotationCommand extends AnnotatedTextCommandBase {
  readonly kind: 'annotation.apply';
  readonly annotation: AnnotatedTextActionAnnotation;
  readonly from: AnnotatedTextPosition;
  readonly to: AnnotatedTextPosition;
}
export interface AnnotatedTextRemoveAnnotationCommand extends AnnotatedTextCommandBase {
  readonly kind: 'annotation.remove';
  readonly annotationId: string;
}
export type AnnotatedTextOperationCommand =
  | AnnotatedTextInsertCommand
  | AnnotatedTextDeleteCommand
  | AnnotatedTextReplaceCommand
  | AnnotatedTextApplyAnnotationCommand
  | AnnotatedTextRemoveAnnotationCommand;

/** One post-edit range, measured in UTF-16 offsets relative to the region start. */
export interface AnnotatedTextRegionRelativeRange {
  readonly start: number;
  readonly end: number;
}

export type AnnotatedTextRegionEditTransition =
  | {
      readonly kind: 'range.set';
      readonly annotationId: string;
      readonly ranges: readonly AnnotatedTextRegionRelativeRange[];
    }
  | {
      readonly kind: 'remove';
      readonly annotationId: string;
    }
  | {
      readonly kind: 'create';
      readonly annotation: {
        readonly id: string;
        readonly family: string;
        readonly fields: Readonly<Record<string, unknown>>;
        readonly protectedTargetIds: readonly string[];
      };
      readonly ranges: readonly AnnotatedTextRegionRelativeRange[];
    };

/** Closed v10 public `region.edit` descriptor. Sole parser: `parseRegionEditDescriptor`. */
export interface AnnotatedTextRegionEditDescriptor {
  readonly version: 10;
  readonly kind: 'region.edit';
  readonly id: string;
  readonly basis: {
    readonly version: 1;
    readonly id: string;
    readonly frontier: unknown;
  };
  readonly from: number;
  readonly to: number;
  readonly coveredTextDigest: string;
  readonly affectedClosureDigest: string;
  readonly expectedCoveredAnnotationIds: readonly string[];
  readonly replacement: string;
  readonly transitions: readonly AnnotatedTextRegionEditTransition[];
}
export function parseRegionEditDescriptor(raw: unknown): AnnotatedTextRegionEditDescriptor;
export function isRegionEditDescriptor(value: unknown): value is AnnotatedTextRegionEditDescriptor;

export interface AnnotatedTextRegionBuildInput {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly replacement: string;
  readonly transitions: readonly unknown[];
  /** Optional immutable wording check used by server-side review commits. */
  readonly expectedText?: string;
}
export interface AnnotatedTextOperationRegion {
  (descriptor: unknown): AnnotatedTextRegionEditDescriptor;
  readonly build: (db: WorkbenchDatabase, input: AnnotatedTextRegionBuildInput) => AnnotatedTextRegionEditDescriptor;
}
export interface AnnotatedTextOperationHandle {
  readonly __brand: 'annotatedTextOperation';
  readonly entity: string;
  readonly field: string;
  readonly region: AnnotatedTextOperationRegion;
}
export function annotatedTextOperation(entity: AnyWorkbenchEntity, field: AnnotatedTextFieldHandle): AnnotatedTextOperationHandle;

/** The `edit` half of a v9 operation payload (command minus id/authoring). */
export type AnnotatedTextOperationEdit =
  | Omit<AnnotatedTextInsertCommand, 'id' | 'authoring'>
  | Omit<AnnotatedTextDeleteCommand, 'id' | 'authoring'>
  | Omit<AnnotatedTextReplaceCommand, 'id' | 'authoring'>
  | Omit<AnnotatedTextApplyAnnotationCommand, 'id' | 'authoring'>
  | Omit<AnnotatedTextRemoveAnnotationCommand, 'id' | 'authoring'>;

/** The v9 operation action payload emitted by `annotatedTextAction`. */
export interface AnnotatedTextOperationPayload {
  readonly version: 9;
  readonly id: string;
  readonly authoring: AnnotatedTextAuthoringBinding;
  readonly edit: AnnotatedTextOperationEdit;
}
export interface AnnotatedTextActionRequest<Payload = unknown> {
  readonly type: string;
  readonly payload: Payload;
}
export function annotatedTextAction(
  /** Runtime-loose slot: any compiled entity fits; variance-safe by construction. */
  entity: AnyWorkbenchEntity,
  field: AnnotatedTextFieldHandle,
  command: AnnotatedTextOperationCommand,
): AnnotatedTextActionRequest<AnnotatedTextOperationPayload>;
export type AnnotatedTextAnnotationActionValues<
  Action extends AnnotatedTextAnnotationEntityActionHandle | AnnotatedTextDomainActionHandle,
> = Action extends AnnotatedTextAnnotationEntityActionHandle
  ? { readonly [Name in keyof Action['input']]: unknown }
  : Action extends AnnotatedTextDomainActionHandle<infer Descriptor>
    ? AnnotatedTextInputValues<Descriptor['input']>
    : never;
export function annotatedTextAnnotationAction<
  Action extends AnnotatedTextAnnotationEntityActionHandle | AnnotatedTextDomainActionHandle,
>(
  /** Runtime-loose slot: any compiled entity fits; variance-safe by construction. */
  entity: AnyWorkbenchEntity,
  field: AnnotatedTextFieldHandle,
  actionHandle: Action,
  input: {
    readonly id: string;
    readonly basis: string;
    readonly mutationId: string;
    readonly from: number;
    readonly to: number;
    readonly values: AnnotatedTextAnnotationActionValues<Action>;
  },
): AnnotatedTextActionRequest;
export interface AnnotatedTextCreateSourceMeasurement {
  readonly family: string;
  readonly payload: unknown;
}
export interface AnnotatedTextCreateInput {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly source?: {
    readonly text: string;
    readonly ranges?: readonly {
      readonly annotationId: string;
      readonly family: string;
      readonly start: number;
      readonly end: number;
      readonly fields?: Readonly<Record<string, unknown>>;
    }[];
    readonly measurements?: readonly AnnotatedTextCreateSourceMeasurement[];
  };
}
export function annotatedTextCreateAction(
  /** Runtime-loose slot: any compiled entity fits; variance-safe by construction. */
  entity: AnyWorkbenchEntity,
  field: AnnotatedTextFieldHandle,
  input: AnnotatedTextCreateInput,
): AnnotatedTextActionRequest;
export function annotatedTextRetireAction(entity: AnyWorkbenchEntity, documentId: string): AnnotatedTextActionRequest<{ readonly id: string }>;

export interface AnnotatedTextAnnotation {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Principal id of the user who applied this annotation; absent on legacy/interop snapshots that predate attribution. */
  readonly owner?: string;
}
export interface AnnotatedTextMeasurement {
  readonly id: string;
  readonly family: string;
  readonly formatVersion: number;
  readonly payload: unknown;
}
/** A stored structural endpoint: RGA point plus the historical basis frontier. */
export interface AnnotatedTextStructuralEndpoint {
  readonly point: readonly ['point', readonly ['root'] | readonly ['element', readonly [readonly [string, number], number]], 'left' | 'right'];
  readonly basisFrontier: readonly (readonly [string, number])[];
}
/** Wire range: offsets on the v1 (redacted) envelope, endpoints on the v2 (fully-visible) envelope. */
export type AnnotatedTextRecipientRange =
  | { readonly annotationId: string; readonly start: number; readonly end: number }
  | { readonly annotationId: string; readonly start: AnnotatedTextStructuralEndpoint; readonly end: AnnotatedTextStructuralEndpoint };
/** The blockless recipient document: one continuous text frame plus document-scoped annotation ranges. */
export interface AnnotatedTextDocument {
  readonly kind: 'workbench.annotatedText.recipient';
  readonly version: 1 | 2;
  readonly text: string;
  readonly ranges: readonly AnnotatedTextRecipientRange[];
  readonly annotations: readonly AnnotatedTextAnnotation[];
  readonly orphans?: readonly {
    readonly id: string;
    readonly family: string;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly savedQuote: string;
    readonly owner?: string;
  }[];
  readonly measurements?: readonly AnnotatedTextMeasurement[];
  readonly capabilities: readonly string[] | null;
  readonly capabilityHints?: readonly string[];
  readonly restricted?: boolean;
  readonly redactions?: readonly { readonly start: number; readonly end: number; readonly placeholder: string }[];
}

// ── Blockless document shapes (live contract) ──────────────────────────────
/** One character range in the document text. Half-open absolute UTF-16 offsets. */
export interface AnnotatedTextDocumentRange {
  readonly annotationId: string;
  readonly start: number;
  readonly end: number;
}
/** An annotation orphaned by a text edit (empty policy 'orphan'): its quote survives. */
export interface AnnotatedTextOrphan {
  readonly id: string;
  readonly family: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly savedQuote: string;
  readonly savedRange: readonly [number, number];
  readonly owner?: string;
}
/**
 * Document-scoped measurement. Blockless model: measurements belong to the
 * whole document — there is no blockId (issue #33).
 */
export interface AnnotatedTextMeasurement {
  readonly id: string;
  readonly family: string;
  readonly formatVersion: number;
  readonly payload: unknown;
}
export interface AnnotatedTextCanonicalDocument {
  readonly kind: 'workbench.annotatedText.canonical';
  readonly version: 1;
  readonly text: string;
  readonly annotations: readonly (AnnotatedTextAnnotation & { readonly protectedTargetIds?: readonly string[] })[];
  readonly ranges: readonly { readonly annotationId: string; readonly start: number; readonly end: number }[];
  readonly orphans: readonly {
    readonly id: string;
    readonly family: string;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly savedQuote: string;
    readonly savedRange: readonly [number, number];
    readonly owner?: string;
  }[];
  readonly measurements: readonly AnnotatedTextMeasurement[];
  readonly capabilityHints: readonly string[];
}
/** An inline redaction inserted into a recipient projection. */
export interface AnnotatedTextRecipientRedaction {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}
export interface AnnotatedTextRecipientDocument {
  readonly kind: 'workbench.annotatedText.recipient';
  readonly version: 1 | 2 | 3;
  readonly text: string;
  readonly ranges: readonly AnnotatedTextRecipientRange[];
  readonly annotations: readonly AnnotatedTextAnnotation[];
  readonly measurements?: readonly AnnotatedTextMeasurement[];
  readonly capabilities: readonly string[] | null;
  readonly capabilityHints?: readonly string[];
  readonly orphans?: readonly {
    readonly id: string;
    readonly family: string;
    readonly fields: Readonly<Record<string, unknown>>;
    readonly savedQuote: string;
    readonly owner?: string;
  }[];
  readonly redactions?: readonly { readonly start: number; readonly end: number; readonly placeholder: string }[];
  readonly restricted?: boolean;
}
export interface AnnotatedTextExpectedOwningScope {
  readonly entity: AnyWorkbenchEntity;
  readonly id: string;
}
export type AnnotatedTextRecipientReadResult =
  | { readonly kind: 'snapshot'; readonly document: AnnotatedTextRecipientDocument; readonly owningScopeCursor: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'retry' };
export function readAnnotatedTextForRecipient(input: {
  readonly app: WorkbenchApp;
  readonly entity: AnyWorkbenchEntity;
  readonly field: AnnotatedTextFieldHandle;
  readonly documentId: string;
  readonly expectedOwningScope: AnnotatedTextExpectedOwningScope;
  readonly principal: Principal;
}): Promise<AnnotatedTextRecipientReadResult>;
export function exportAnnotatedText(input: {
  readonly app: WorkbenchApp;
  readonly entity: AnyWorkbenchEntity;
  readonly field: AnnotatedTextFieldHandle;
  readonly documentId: string;
  readonly expectedOwningScope: AnnotatedTextExpectedOwningScope;
  readonly principal: Principal;
}): Promise<AnnotatedTextCanonicalDocument>;

export function boolean<const Options extends FieldOptions<boolean>>(options?: Options): FieldDescriptor<DeclaredValue<Options, boolean>, DeclaredMode<Options>>;
/** Date columns project ISO strings; declaration-level defaults and checks may use runtime Date values. */
export type DateFieldOptions = Omit<FieldOptions<string>, 'default' | 'validate' | 'canonicalize'> & {
  default?: string | Date | (() => string | Date);
  validate?: (value: string | Date) => true | string;
  canonicalize?: (value: string | Date) => string | Date;
};
export function date<const Options extends DateFieldOptions>(options?: Options): FieldDescriptor<DeclaredValue<Options, string>, DeclaredMode<Options>>;
export function number<const Options extends FieldOptions<number>>(options?: Options): FieldDescriptor<DeclaredValue<Options, number>, DeclaredMode<Options>>;
export function json<Value = unknown>(shape?: unknown, options?: FieldOptions<Value>): FieldDescriptor<Value>;
export function ref<const Options extends FieldOptions<string> & { role?: string | readonly string[] }>(
  target: string | AnyWorkbenchEntity,
  options?: Options,
): FieldDescriptor<DeclaredValue<Options, string>, DeclaredMode<Options>>;
export function hash(options?: FieldOptions<string>): FieldDescriptor<string>;
export function blob<const Options extends FieldOptions<string>>(options?: Options): FieldDescriptor<DeclaredValue<Options, string>, DeclaredMode<Options>>;
export function link(options?: Readonly<Record<string, unknown>>): FieldDescriptor<Record<string, unknown>>;
export function map<Value = unknown>(
  value: FieldDescriptor<Value>,
  options?: FieldOptions<Record<string, Value>>,
): FieldDescriptor<Record<string, Value>>;
export function list<Value = unknown>(
  value: FieldDescriptor<Value>,
  options?: FieldOptions<Value[]>,
): FieldDescriptor<Value[]>;
export function log<Entry extends Record<string, FieldDescriptor> = Record<string, never>>(
  entry?: Entry,
): FieldDescriptor<unknown[]>;
export function ephemeral<Cells extends Record<string, FieldDescriptor | boolean> = Record<string, never>>(
  cells?: Cells,
): FieldDescriptor<unknown>;
export interface StateFieldFactory {
  <const Options extends { values?: readonly unknown[]; transitions?: Record<string, unknown>; effects?: Record<string, unknown>; auto?: unknown }>(options?: Options): FieldDescriptor<StateValueOf<Options>, 'required'>;
  transition<From extends string, To extends string>(
    from: From,
    to: To,
  ): Readonly<{
    brand: 'state-transition-handle';
    from: From;
    to: To;
    readonly type: `transition:${From}->${To}`;
    toString(): string;
  }>;
}
export const state: StateFieldFactory;

// A state field's row value: the closed declared domain when it is a literal
// tuple of names, else plain string.
type StateValueOf<Options> = Options extends { values: readonly (infer Value)[] } ? (Value extends string ? Value : string) : string;
export interface ComputedFieldFactory {
  <Value = unknown>(
    options: { compute: (row: Readonly<Record<string, unknown>>) => Value },
  ): FieldDescriptor<Value>;
  stored<Value = unknown>(
    options: { compute: (row: Readonly<Record<string, unknown>>) => Value },
  ): FieldDescriptor<Value>;
}
export const computed: ComputedFieldFactory;
export interface ProjectedFieldFactory {
  async<Value = unknown>(options: {
    compute: (
      row: Readonly<Record<string, unknown>>,
      context: { readonly db: WorkbenchDatabase },
    ) => Value | Promise<Value>;
    from?: string | readonly string[];
  }): FieldDescriptor<Value>;
}
export const projected: ProjectedFieldFactory;
export const raster: { crdt(options?: Readonly<Record<string, unknown>>): FieldDescriptor<unknown> };
export const polyline: { crdt(options?: Readonly<Record<string, unknown>>): FieldDescriptor<unknown> };
export function vector<const Options extends FieldOptions<number[]>>(dimensions: number, options?: Options): FieldDescriptor<DeclaredValue<Options, number[]>, DeclaredMode<Options>>;

declare class CapabilityToken<Name extends string> {
  readonly capability: Name;
  #brand: Name;
}
export type Capability<Name extends string = string> = CapabilityToken<Name>;
export const read: Capability<'read'>;
export const write: Capability<'write'>;
export const subscribe: Capability<'subscribe'>;
export const admin: Capability<'admin'>;
export interface OwnerFieldFactory {
  (): FieldDescriptor<string>;
  only(): readonly ScopeClause[];
}
export const owner: OwnerFieldFactory;

export type GrantDecision =
  | { readonly granted: true; readonly capabilities: readonly Capability[] }
  | { readonly granted: false; readonly reason: unknown };
export function grant(...capabilities: Capability[]): GrantDecision;
export function deny(reason?: unknown): GrantDecision;

export interface ScopeClause {
  readonly predicate?: (context: unknown) => boolean;
  can(check: (context: unknown) => GrantDecision): ScopeClause;
  readonly [property: string]: unknown;
}
export type ScopePredicate = (context: unknown) => unknown;
export function scope(predicate: ScopePredicate): ScopeClause;
export const everyone: ScopePredicate;
export const never: ScopePredicate;
export function anyOf(...clauses: ScopePredicate[]): ScopePredicate;
export interface InheritDirective {
  readonly inherit: AnyWorkbenchEntity;
  readonly via: string;
}
export function inherit(
  parent: AnyWorkbenchEntity,
  options: { via: string },
): InheritDirective;

export interface ActionHandle<Payload = Record<string, unknown>> {
  readonly brand: 'action';
  readonly type: string;
  readonly __payload?: Payload;
}
export interface EventHandle<State = unknown, Payload = Record<string, unknown>> {
  readonly brand: 'event';
  readonly type: string;
  readonly reduce: (state: State, payload: Payload) => State;
}
export function action<Payload = Record<string, unknown>>(type: string): ActionHandle<Payload>;
export function event<State = unknown, Payload = Record<string, unknown>>(
  type: string | Readonly<Record<string, unknown>>,
  reduce: (state: State, payload: Payload) => State,
): EventHandle<State, Payload>;

export type AtomicOperation =
  | Readonly<{ kind: 'setAdd'; field: string; value: unknown }>
  | Readonly<{ kind: 'setRemove'; field: string; value: unknown }>
  | Readonly<{ kind: 'increment'; field: string; by: number }>
  | Readonly<{ kind: 'claim'; field: string; value: unknown }>
  | Readonly<{ kind: 'acknowledge'; field: string }>
  | Readonly<{ kind: 'toggleTo'; field: string; value: boolean }>;
export const ATOMIC_OPERATION_KINDS: readonly ['setAdd', 'setRemove', 'increment', 'claim', 'acknowledge', 'toggleTo'];
export interface AtomicExecution {
  readonly row: Readonly<Record<string, unknown>>;
  readonly applied: boolean;
}
export interface AtomicOperationContext {
  readonly payload: unknown;
  readonly principal: unknown;
  readonly db: unknown;
  readonly now: string;
  readonly scope: string;
  readonly actionId: string;
}
/** Opaque compiled-entity handle for runtime-loose slots; any entity fits. */
export interface AnyWorkbenchEntity {
  readonly name: string;
  readonly [member: string]: unknown;
}

export interface AtomicOperationRegistration {
  /** Any compiled entity handle; the atomic pipeline reads it opaquely. */
  readonly entity: AnyWorkbenchEntity;
  readonly read: (context: AtomicOperationContext) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
}
export type AtomicOperationHandler = ((context: AtomicOperationContext & { readonly atomic: AtomicExecution }) => unknown) & {
  readonly inTransaction?: boolean;
  readonly atomicOperation?: AtomicOperationRegistration;
};
export function setAdd(field: string, value: unknown): AtomicOperation;
export function setRemove(field: string, value: unknown): AtomicOperation;
export function increment(field: string, by?: number): AtomicOperation;
export function claim(field: string, value: unknown): AtomicOperation;
export function acknowledge(field: string): AtomicOperation;
export function toggleTo(field: string, value: boolean): AtomicOperation;
export function isAtomicOperation(value: unknown): value is AtomicOperation;
export function executeAtomicOperation(row: Readonly<Record<string, unknown>>, operation: AtomicOperation): AtomicExecution;
export function executeAtomicOperations(row: Readonly<Record<string, unknown>>, operations: readonly AtomicOperation[]): AtomicExecution;
export function atomicOperation(registration: AtomicOperationRegistration, handler: AtomicOperationHandler): AtomicOperationHandler;

export interface CommittedEvent<Data = unknown> {
  readonly type: string;
  readonly scope: string;
  readonly seq: number;
  readonly actionId: string;
  readonly committedAt: string;
  readonly data: Data;
}
export interface DispatchRequest<Payload = Record<string, unknown>> {
  actionId: string;
  type: string;
  payload: Payload;
  principal: Principal;
  scope?: string;
  /** Caller-owned session identifier recorded with the immutable action receipt. */
  clientId?: string;
  history?: { session: string };
}
export type DispatchResult<Event extends CommittedEvent = CommittedEvent> =
  | {
      readonly ok: true;
      readonly events: readonly Event[];
      readonly deduped: boolean;
    }
  | FailureOutcome;

export interface BatchAction<Payload = Record<string, unknown>> {
  readonly type: string;
  readonly payload: Payload;
  readonly scope?: string;
}

export type BatchActionFactory<Action extends BatchAction = BatchAction> =
  () => readonly Action[];

export type ApplicationHttpCrudVerb = 'create' | 'update' | 'remove';

export interface WorkbenchEntity<Row extends object = Record<string, unknown>> {
  readonly name: string;
  readonly fields: Readonly<Record<string, FieldDescriptor<unknown, FieldMode>>>;
  readonly indexes: readonly EntityIndexDeclaration<Row>[];
  readonly field: EntityFields<Row>;
  readonly verbs: Readonly<Record<string, ActionHandle | EventHandle>>;
  readonly routes?: (routes: EntityRouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
  readonly applicationHttpActions?: readonly ApplicationHttpCrudVerb[];
  readonly [member: string]: unknown;
}

export type EntityIndexFields<Row extends object> = readonly [keyof Row & string, keyof Row & string, ...(keyof Row & string)[]];
export interface EntityIndexDeclaration<Row extends object> {
  readonly fields: EntityIndexFields<Row>;
  readonly unique: boolean;
}

type SelectedKeys<Row extends object, Fields extends readonly FieldHandle<any, any>[]> =
  Extract<Fields[number] extends FieldHandle<any, infer Key> ? Key : never, keyof Row>;

export interface QueryBuilder<Row extends object> extends PromiseLike<Row[]> {
  sort(field: FieldHandle, direction?: 'asc' | 'desc'): this;
  limit(count: number): this;
  select<Fields extends readonly FieldHandle<any, any>[]>(
    ...fields: Fields
  ): QueryBuilder<Pick<Row, SelectedKeys<Row, Fields>>>;
}

export interface HydratedRows<Row extends object> extends Array<Row> {
  select<Fields extends readonly FieldHandle<any, any>[]>(
    ...fields: Fields
  ): Array<Pick<Row, SelectedKeys<Row, Fields>>>;
}

export interface BoundWorkbenchEntity<Row extends object = Record<string, unknown>>
  extends WorkbenchEntity<Row> {
  create(payload: Partial<Row> & Record<string, unknown>): Row;
  insert(payload: Partial<Row> & Record<string, unknown>): Row;
  delete(id: string): void;
  findById(id: string, principal?: Principal): Row | null;
  findOne(where: QueryPredicate): Row | null;
  findAll(): HydratedRows<Row>;
  findAll(where: QueryPredicate): QueryBuilder<Row>;
  getOrFail(id: string, principal?: Principal): Row;
}

// S3 — live data tier vocabulary. `history` | `live` are entity tiers;
// `derived` and `operational` are resource categories (declared via their own
// producer + staleness contract, not entity mutation tiers). The default tier
// is `history` with full history — zero behavior change for existing entities.
export type DataTier = 'history' | 'live' | 'derived' | 'operational';
export type EntityTier = 'history' | 'live';
export type HistoryMode = 'full' | 'conditional';
export type HistoryVerb = 'create' | 'update';
// `none` is reserved vocabulary for the no-history mutation variant (S3/A2):
// declaring it today is rejected at compile and redirected to live: true.
export type HistoryVerbMode = 'conditional' | 'full' | 'none';

export const DATA_TIERS: readonly ['history', 'live', 'derived', 'operational'];
export const ENTITY_TIERS: readonly ['history', 'live'];
export const TIER_DESCRIPTIONS: Readonly<Record<DataTier, string>>;

export function isDataTier(value: unknown): value is DataTier;
export function isEntityTier(value: unknown): value is EntityTier;

export type TierDeclaration = Readonly<{
  history?: Readonly<Partial<Record<HistoryVerb, HistoryVerbMode>>>;
  live?: boolean;
  tier?: DataTier;
}>;

export interface ResolvedTier {
  readonly tier: DataTier;
  readonly historyMode?: HistoryMode;
}

// Normalize a tier declaration into a resolved tier. Throws at declaration
// compile (never at query time): a live entity that also requests durable
// history is a hard error; derived/operational are resource categories, not
// entity tiers; `history: 'none'` is reserved for S3/A2 and redirected to
// live: true.
export function normalizeTierDeclaration(declaration?: TierDeclaration, label?: string): ResolvedTier;
// Resolve the live-data tier of a declared entity or resource. Entities
// resolve to `history` (default) or `live`; derived/operational resources →
// their category. Raw tier declarations run the same normalization/validation
// as normalizeTierDeclaration, so contradictory raw objects fail closed.
export function tierOf(resource: unknown): DataTier;

export type EntityDeclaration<Row extends object> = Readonly<Record<string, unknown>> & {
  routes?: (routes: EntityRouteBuilder, entity: BoundWorkbenchEntity<Row>) => unknown | Promise<unknown>;
  grant?: ScopeClause | ScopePredicate | InheritDirective | GrantDecision | ((context: unknown) => GrantDecision);
  history?: Readonly<{ create?: HistoryVerbMode; update?: HistoryVerbMode }>;
  live?: boolean;
  tier?: EntityTier;
  indexes?: readonly EntityIndexDeclaration<Row>[];
  /** Explicit allowlist of generated CRUD verbs admitted on POST /workbench/actions. */
  applicationHttpActions?: readonly ApplicationHttpCrudVerb[];
};
/** Top-level declaration slots the compiler owns; never row fields. */
export type ReservedDeclarationSlot =
  | 'fields' | 'grant' | 'checks' | 'routes' | 'create' | 'effects' | 'admitsEffects'
  | 'schedule' | 'simulation' | 'gate' | 'on' | 'membership' | 'field' | 'history'
  | 'indexes' | 'applicationHttpActions' | 'live' | 'tier';

/** The row value one declared field descriptor projects: optional descriptors may be absent/null. */
type DescriptorRowValue<Descriptor> = Descriptor extends { readonly __value?: infer Value; readonly __mode?: infer Mode }
  ? Mode extends 'optional' ? Value | null | undefined : Value
  : unknown;

/** The hydrated row shape derived from an entity declaration record. */
export type EntityRowOf<Declaration> = {
  /** Every row carries the primary key, declared or not. */
  readonly id: string;
} & {
  [Key in keyof Declaration as Key extends ReservedDeclarationSlot ? never : Key & string]: DescriptorRowValue<Declaration[Key]>;
};

export function entity<const Name extends string, const Declaration extends EntityDeclaration<Record<string, unknown>>>(
  name: Name,
  declaration?: Declaration,
): WorkbenchEntity<EntityRowOf<Declaration>>;

export function membership<Row extends object>(
  entity: BoundWorkbenchEntity<Row>,
  roles: Readonly<Record<string, unknown>>,
): BoundWorkbenchEntity<Row>;
export function membership<Row extends object>(
  entity: WorkbenchEntity<Row>,
  roles: Readonly<Record<string, unknown>>,
): WorkbenchEntity<Row>;

declare const projectionSourceFieldBrand: unique symbol;
declare const projectionSourceBrand: unique symbol;
declare const principalSnapshotManyBrand: unique symbol;
declare const principalSnapshotObjectBrand: unique symbol;
declare const principalSnapshotDeclarationBrand: unique symbol;

export interface ProjectionSourceField {
  readonly [projectionSourceFieldBrand]: true;
  readonly kind: 'sourceField';
  readonly source: ProjectionSource;
  readonly column: string;
  readonly entityName: string;
  readonly fieldName: string;
}
export interface ProjectionSourceFieldWithDirection extends ProjectionSourceField {
  readonly direction: 'asc' | 'desc';
}

export interface ProjectionSource {
  readonly [projectionSourceBrand]: true;
  readonly kind: 'projectionSource';
  readonly schema: import('./src/server.js').SqliteSchemaResult | null;
  readonly table: string;
  /** Set for physical (host-declared) sources; undefined for schema sources. */
  readonly physicalColumns?: readonly string[];
  readonly field: Readonly<Record<string, ProjectionSourceField>>;
}
export function projectionSource(schema: import('./src/server.js').SqliteSchemaResult, table: string): ProjectionSource;
/**
 * A projection source over a host PYSICAL table with an explicit column list,
 * decoupled from the application-schema declaration gate. For hub tables the
 * host owns but cannot schema-declare (single-owner / entity-owned / framework
 * grant tables). Fail closed: only the declared columns are ever projected, and
 * the field proxy exposes only declared columns.
 */
export function projectionSourcePhysical(table: string, columns: readonly string[]): ProjectionSource;

export interface PrincipalSnapshotJoin {
  readonly [principalSnapshotManyBrand]: true;
  readonly kind: 'join';
  readonly source: ProjectionSource;
  readonly on: { readonly from: ProjectionSourceField; readonly to: ProjectionSourceField };
  readonly select: readonly ProjectionSourceField[];
}
export interface PrincipalSnapshotMany {
  readonly [principalSnapshotManyBrand]: true;
  readonly kind: 'many';
  readonly source: ProjectionSource;
  readonly via: ProjectionSourceField;
  readonly key: ProjectionSourceField;
  readonly select: readonly ProjectionSourceField[];
  readonly orderBy?: readonly ProjectionSourceFieldWithDirection[];
  readonly join?: PrincipalSnapshotJoin;
}
export interface PrincipalSnapshotObject {
  readonly [principalSnapshotObjectBrand]: true;
  readonly kind: 'object';
  readonly shape: Readonly<Record<string, PrincipalSnapshotMany>>;
}
export interface PrincipalSnapshotDeclaration {
  readonly [principalSnapshotDeclarationBrand]: true;
  readonly kind: 'principalSnapshot';
  readonly name: string;
  readonly principalType: Exclude<PrincipalType, 'anonymous'>;
  readonly output: PrincipalSnapshotObject;
  readonly fields: Readonly<Record<string, PrincipalSnapshotMany>>;
}
export interface PrincipalSnapshotGrammar {
  (name: string, options: { principalType: Exclude<PrincipalType, 'anonymous'>; output: PrincipalSnapshotObject }): PrincipalSnapshotDeclaration;
  object(shape: Readonly<Record<string, PrincipalSnapshotMany>>): PrincipalSnapshotObject;
  many(source: ProjectionSource, options: {
    via: ProjectionSourceField;
    key: ProjectionSourceField;
    select: readonly ProjectionSourceField[];
    orderBy?: readonly ProjectionSourceFieldWithDirection[];
    join?: { source: ProjectionSource; on: { from: ProjectionSourceField; to: ProjectionSourceField }; select: readonly ProjectionSourceField[] };
  }): PrincipalSnapshotMany;
  select(...handles: readonly ProjectionSourceField[]): readonly ProjectionSourceField[];
  orderBy(handle: ProjectionSourceField, direction?: 'asc' | 'desc'): ProjectionSourceFieldWithDirection;
}
export const principalSnapshot: PrincipalSnapshotGrammar;

export interface PrincipalSnapshotTransaction {
  readonly db: WorkbenchDatabase;
  invalidate(declaration: PrincipalSnapshotDeclaration, recipient: { type: Exclude<PrincipalType, 'anonymous'>; id: string }): void;
}

export interface PrincipalSnapshotTransactionApi {
  transaction<T>(callback: (tx: PrincipalSnapshotTransaction) => T): Promise<T>;
}

export function principalSnapshotScope(options: { declaration: string; principal: { type: Exclude<PrincipalType, 'anonymous'>; id: string } }): string;

/**
 * Host reauthorization for principal snapshots. Invoked before every recipient
 * projection (bootstrap / catchup / subscribe / resync). A denial, an
 * authorizer error, or a non-true result fails closed: one-shot reads return
 * revoked, and an open subscription is revoked before any replacement
 * projection is delivered. With NO authorizer supplied, every access is denied.
 */
export type PrincipalSnapshotAccessTrigger = 'bootstrap' | 'catchup' | 'subscribe' | 'resync';
export interface PrincipalSnapshotAccessInput {
  readonly declaration: PrincipalSnapshotDeclaration;
  readonly principal: { readonly type: Exclude<PrincipalType, 'anonymous'>; readonly id: string };
  readonly trigger: PrincipalSnapshotAccessTrigger;
}
export type PrincipalSnapshotAuthorize =
  (input: PrincipalSnapshotAccessInput) => boolean | Promise<boolean>;

export function inc(value: number): Readonly<{ kind: 'inc'; value: number }>;
export function dec(value: number): Readonly<{ kind: 'dec'; value: number }>;
export const self: Readonly<Record<string, unknown>>;
export function many(
  target: WorkbenchEntity,
  options: { over: FieldDescriptor },
): Readonly<Record<string, unknown>>;
export const effect: {
  anyOf(...triggers: readonly unknown[]): symbol;
};
export const now: Readonly<{ kind: 'deferred'; resolve: 'commit-instant' }>;

export interface ScheduleOptions<Row extends object = Record<string, unknown>> {
  readonly key?: string;
  readonly while?: (context: { readonly fields: EntityFields<Row> }) => QueryPredicate;
  readonly when?: (context: { readonly row: Readonly<Row & { id: string }> }) => boolean;
  readonly with?: Partial<Row> | null | (
    (context: { readonly row: Readonly<Row & { id: string }> }) => Partial<Row>
  );
}
export type ScheduleTrigger<Row extends object = Record<string, unknown>> =
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'schedule.at';
      field: FieldDescriptor;
    }>)
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'schedule.after';
      field: FieldDescriptor;
      delay: number;
    }>)
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'tick.hz';
      hertz: number;
    }>)
  | (ScheduleOptions<Row> & Readonly<{
      kind: 'tick.every';
      intervalMs: number;
    }>);
export const schedule: {
  at<Row extends object = Record<string, unknown>>(field: FieldDescriptor, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
  after<Row extends object = Record<string, unknown>>(field: FieldDescriptor, delay: number | string, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
};
export const tick: {
  hz<Row extends object = Record<string, unknown>>(value: number, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
  every<Row extends object = Record<string, unknown>>(delay: number | string, options?: ScheduleOptions<Row>): ScheduleTrigger<Row>;
};
export function simulate(options: Readonly<Record<string, unknown>>): unknown;

export interface WorkbenchLog {
  readonly level: number;
  readonly channels: Readonly<Record<string, string>>;
  readonly format: string;
  trace(channel: string, message: string, context?: Record<string, unknown>): void;
  debug(channel: string, message: string, context?: Record<string, unknown>): void;
  info(channel: string, message: string, context?: Record<string, unknown>): void;
  warn(channel: string, message: string, context?: Record<string, unknown>): void;
  error(channel: string, message: string, context?: Record<string, unknown>): void;
}

export interface WorkbenchClock {
  add(options: {
    name: string;
    intervalMs: number;
    fn: () => void | Promise<void>;
    delayMs?: number;
  }): { remove(): void };
  stop(): void;
}

export interface RateLimitWindow {
  windowMs: number;
  max: number;
}

export interface ListenOptions {
  principalOf?: (request: IncomingMessage) => Principal;
  onListening?: () => void;
  env?: string;
  rateLimit?: {
    ip: RateLimitWindow;
    session?: RateLimitWindow;
    /** Optional raised window for trusted local peers (loopback/private-network addresses — the operator's own machine). When present, loopback/private peers are capped by `local` instead of `ip`/`session`, so self-hosted / dev traffic (e.g. Vite's per-module asset fetches) does not trip the production edge budget. Remote (public) peers ALWAYS use `ip`/`session`. */
    local?: RateLimitWindow;
  };
  csp?: string;
  hsts?: boolean;
  cors?: { origins: readonly string[] };
  requestLog?: boolean;
  /** The authorization adapter — THE admission path for the route gate, REST CRUD dispatch, live delivery, and registered durable actions. */
  authorization?: AuthorizationAdapter;
}

/**
 * A field handle as the snapshot grammar reads it. `Key` carries the field NAME
 * as a literal type (real entity handles satisfy this structurally), and the
 * phantoms carry value/mode knowledge for projection-shape inference.
 */
export interface SnapshotFieldHandle<Value = unknown, Key extends string = string, Mode extends FieldMode = 'required'> {
  readonly fieldName: Key;
  readonly entityName?: string;
  readonly __value?: Value;
  readonly __mode?: Mode;
}

export interface SnapshotSelect<Shape = unknown> { readonly kind: 'select'; readonly __shape?: Shape; }
export interface SnapshotOrder { readonly kind: 'orderBy'; }
export interface SnapshotOutput<Shape extends Record<string, unknown> = Record<string, unknown>> { readonly kind: 'object'; readonly shape: Shape; }
export interface SnapshotRelation<Kind extends 'one' | 'many' | 'keyed' | 'count' = 'one' | 'many' | 'keyed' | 'count', Child = unknown> { readonly kind: Kind; readonly __child?: Child; }
export interface SnapshotRelated { readonly kind: 'related'; }
export interface SnapshotUser { readonly kind: 'user'; }
export interface SnapshotTombstones { readonly kind: 'tombstones'; }
/** A complete snapshot declaration over an anchor entity. */
export interface SnapshotDeclaration<Output extends SnapshotOutput = SnapshotOutput> {
  readonly kind: 'snapshot';
  readonly anchor: unknown;
  readonly output: Output;
  readonly tombstones?: SnapshotTombstones;
}

type UnionToIntersection<U> = (U extends unknown ? (intersection: U) => void : never) extends (intersection: infer I) => void ? I : never;

/** The row shape a select contributes: one entry per selected field, keyed by the handle's literal name. */
type SelectedShape<Handles extends readonly unknown[]> = UnionToIntersection<
  { [Index in keyof Handles]: Handles[Index] extends SnapshotFieldHandle<infer Value, infer Key, infer Mode>
    ? string extends Key
      ? {}
      : Mode extends 'optional'
        ? { [Field in Key & string]?: Value }
        : { [Field in Key & string]: Value }
    : unknown }[number]
>;

/** The child projection a relation carries: its include object, else its select, else nothing (count). */
type SnapshotChildProjection<Options> = Options extends { include: infer Included } ? Included
  : Options extends { select: infer Selected } ? Selected
  : Options extends { output: infer Output } ? Output
  : undefined;

/** The projected value of one relation entry, by kind. */
type SnapshotRelationValue<Kind extends 'one' | 'many' | 'keyed' | 'count', Child> = Kind extends 'count'
  ? number
  : Kind extends 'one'
    ? SnapshotChildValue<Child> | null
    : Kind extends 'keyed'
      ? { readonly [id: string]: SnapshotChildValue<Child> }
      : readonly SnapshotChildValue<Child>[];

/** A relation child row: nested include objects recurse; selects flatten onto the id. */
type SnapshotChildValue<Child> = Child extends SnapshotOutput<infer Shape>
  ? SnapshotRowOf<Shape>
  : Child extends SnapshotSelect<infer Shape>
    ? { readonly id: string } & Shape
    : { readonly id: string };

/** The recipient User projection shape. */
export interface SnapshotUserValue {
  readonly id: string;
  readonly name: string | null;
  readonly image: string | null;
}

/** One output branch value: relations by kind, users as the fixed identity shape. Selects flatten (never a key). */
type SnapshotEntryValue<Entry> = Entry extends SnapshotRelation<infer Kind, infer Child>
  ? SnapshotRelationValue<Kind, Child>
  : Entry extends SnapshotUser
    ? SnapshotUserValue | null
    : unknown;

/** The projected row for an output shape: id, selects flattened, plus one property per relation/user branch. */
type SnapshotRowOf<Shape extends Record<string, unknown>> = { readonly id: string }
  & UnionToIntersection<{ [Key in keyof Shape]: Shape[Key] extends SnapshotSelect<infer Flattened> ? Flattened : {} }[keyof Shape]>
  & { [Key in keyof Shape as Shape[Key] extends SnapshotSelect ? never : Key & string]: SnapshotEntryValue<Shape[Key]> };

/**
 * The data shape a snapshot declaration projects. Accepts a full declaration or
 * a bare output object; loose declarations degrade to `unknown`. Hosts derive
 * their snapshot types from this — write the declaration once.
 */
export type SnapshotValue<Declaration> = Declaration extends SnapshotDeclaration<infer Output>
  ? SnapshotRowOf<Output['shape']>
  : Declaration extends SnapshotOutput<infer Shape>
    ? SnapshotRowOf<Shape>
    : unknown;

export interface SnapshotGrammar {
  <const Options extends { output: SnapshotOutput; tombstones?: SnapshotTombstones }>(anchor: unknown, options?: Options): SnapshotDeclaration<Options['output']>;
  object<const Shape extends Readonly<Record<string, SnapshotSelect | SnapshotRelation | SnapshotUser>>>(shape: Shape): SnapshotOutput<Shape>;
  select<const Handles extends readonly SnapshotFieldHandle<unknown, string, FieldMode>[]>(...handles: Handles): SnapshotSelect<SelectedShape<Handles>>;
  one<const Options extends { via: SnapshotFieldHandle<unknown, string, FieldMode>; select?: SnapshotNode; include?: SnapshotNode; output?: SnapshotNode; orderBy?: SnapshotOrder }>(entity: unknown, options?: Options): SnapshotRelation<'one', SnapshotChildProjection<Options>>;
  many<const Options extends { via: SnapshotFieldHandle<unknown, string, FieldMode>; require?: SnapshotRelated; select?: SnapshotNode; include?: SnapshotNode; output?: SnapshotNode; orderBy?: SnapshotOrder }>(entity: unknown, options?: Options): SnapshotRelation<'many', SnapshotChildProjection<Options>>;
  keyed<const Options extends { via: SnapshotFieldHandle<unknown, string, FieldMode>; require?: SnapshotRelated; select?: SnapshotNode; include?: SnapshotNode; output?: SnapshotNode; orderBy?: SnapshotOrder }>(entity: unknown, options?: Options): SnapshotRelation<'keyed', SnapshotChildProjection<Options>>;
  count<const Options extends { via: SnapshotFieldHandle<unknown, string, FieldMode>; require?: SnapshotRelated }>(entity: unknown, options?: Options): SnapshotRelation<'count'>;
  related(childRef: SnapshotFieldHandle<unknown, string, FieldMode>, options: { via: SnapshotFieldHandle }): SnapshotRelated;
  user(options: { via: SnapshotFieldHandle }): SnapshotUser;
  tombstones(target: unknown, options: { entity: unknown; entityId: SnapshotFieldHandle<unknown, string, FieldMode>; scopeId?: SnapshotFieldHandle<unknown, string, FieldMode>; targetScopeId?: SnapshotFieldHandle<unknown, string, FieldMode>; targetScope?: unknown; terminalScope?: unknown; kind: SnapshotFieldHandle<unknown, string, FieldMode>; state: SnapshotFieldHandle<unknown, string, FieldMode>; kindValue: string; hidden: readonly string[] }): SnapshotTombstones;
  include<const Shape extends Readonly<Record<string, SnapshotSelect | SnapshotRelation>>>(shape: Shape): SnapshotOutput<Shape>;
  orderBy(field: SnapshotFieldHandle<unknown, string, FieldMode>, direction?: 'asc' | 'desc'): SnapshotOrder;
}
/** Any declaration grammar node. */
export type SnapshotNode = SnapshotSelect | SnapshotOutput | SnapshotRelation | SnapshotUser;
export const snapshot: SnapshotGrammar;
export const object: SnapshotGrammar['object'];
export const one: SnapshotGrammar['one'];
export const keyed: SnapshotGrammar['keyed'];
export const select: SnapshotGrammar['select'];
export const include: SnapshotGrammar['include'];
export const orderBy: SnapshotGrammar['orderBy'];
export const count: SnapshotGrammar['count'];
export const related: SnapshotGrammar['related'];
export const user: SnapshotGrammar['user'];
export const tombstones: SnapshotGrammar['tombstones'];

export interface AppLiveDeliveryOptions {
  /** Uses the same authenticated principal shape as the application kernel. */
  principalOf(request: IncomingMessage): Principal | Promise<Principal>;
  path?: string;
  maxSubscriptions?: number;
  /** Constrained relational snapshots; no event, SQL, or callback access. */
  snapshots?: readonly SnapshotDeclaration[];
  /** Read-only principal-anchored recipient snapshots. */
  principalSnapshots?: readonly PrincipalSnapshotDeclaration[];
  /** Host reauthorization for principal snapshots; every principal-snapshot
   *  access fails closed without one. */
  principalSnapshotAuthorize?: PrincipalSnapshotAuthorize | null;
  maxCatchupEvents?: number;
}

/** Transport-neutral delivery operations for focused hosts and tests. */
export interface ApplicationDeliveryTestSurface {
  bootstrap(input: {
    principal: Principal;
    scope: string;
    document?: unknown;
    capabilities?: readonly string[];
  }): Promise<unknown>;
  catchup(input: {
    principal: Principal;
    scope: string;
    after?: number | Readonly<{ anchor: number; aggregate: number }>;
    document?: unknown;
    capabilities?: readonly string[];
    projectionToken?: string;
  }): Promise<unknown>;
  subscribe(input: Record<string, unknown>): Promise<unknown>;
}

/** Read-only application delivery state; the test surface shares live authority with transports. */
export interface ApplicationDelivery {
  readonly attached: boolean;
  readonly test: ApplicationDeliveryTestSurface | null;
}

export interface WorkbenchOptions {
  db?: string | WorkbenchDatabase;
  /** Declares physical SQLite tables. Named entity main tables are never generated. */
  schema?: import('./src/server.js').SqliteSchemaResult;
  entities?: readonly AnyWorkbenchEntity[];
  actions?: readonly RegisteredAction<any, RegisteredProjection>[];
  port?: number;
  env?: string;
  requireEnv?: readonly string[];
  session?: { durationMs?: number };
  viewsDir?: string;
  /** Map a coarse recovery scope to the entity row that owns its authorization. */
  resolveScope?: (
    scope: string,
  ) => { entity: string; id: string | number } | null | Promise<{ entity: string; id: string | number } | null>;
  /** Build a coarse snapshot after its resolved anchor row has been authorized. */
  scopeSnapshot?: (
    scope: string,
    principal: Principal,
    anchor: { entity: string; id: string; row: Record<string, unknown> },
  ) => unknown | Promise<unknown>;
  history?: DurableHistoryDescriptor;
  migrations?: readonly Readonly<{
    /** Per-namespace migration ledger identity (S2/A4 namespaced ledger, #90). */
    namespace: string;
    /** Human-readable migration name, unique per namespace. */
    name: string;
    /** Positive version; identity is the (namespace, version) pair. */
    version: number;
    /** Cross-namespace dependencies, e.g. `"workbench@5"`. */
    dependencies?: readonly string[];
    /** Pinned immutable fingerprint; when absent the runner derives one from `up`. */
    checksum?: string;
    /** The package/app version that supplied this migration. */
    suppliedBy?: string;
    up(db: WorkbenchDatabase): void;
  }>[];
  jobs?: Readonly<Record<string, unknown>>;
  blobs?: Readonly<Record<string, unknown>>;
  log?: Readonly<Record<string, unknown>>;
  /** Pending-blob sweep cadence in milliseconds; must be finite and > 0. */
  blobReapIntervalMs?: number;
  /**
   * Back-compat alias for `blobRetention.abandonedUploadTtlMs` (S6/A5): the
   * SAME knob as that policy — an explicit scalar folds into the policy, a
   * conflicting explicit pair is refused, and the two can never diverge.
   */
  blobReapTtlMs?: number;
  /** Durable-log retention in days; finite and >= 0, with 0 disabling retention. */
  logRetentionDays?: number;
  /** Durable-log sweep cadence in milliseconds; must be finite and > 0. */
  logRetentionIntervalMs?: number;
  /**
   * Age cutoff (days) for receipt `resultData` compaction: a receipt past the
   * cutoff keeps its commit acknowledgement but loses the stored result payload.
   * Finite and >= 0, with 0 (the default) never compacting.
   */
  resultDataRetentionDays?: number;
  /**
   * Minimum serialized size (UTF-8 bytes) at which durable-log event payloads
   * and receipt result payloads are stored as gzip envelopes: heavy payloads
   * (transcript-style operations) compress ~20x, and reads decode transparently
   * across mixed plain/envelope histories. Finite and >= 0, with 0 (the
   * default) writing every payload exactly as before.
   */
  payloadCompressionMinBytes?: number;
  /** Named blob retention policies (S6/A5): a partial override is filled from the central defaults. */
  blobRetention?: Readonly<Partial<{
    /** Abandoned-upload TTL (ms): a staged, never-claimed upload is reaped after this. */
    abandonedUploadTtlMs: number;
    /** Replaced-generation retention (ms): the readable window after the owning reference switched before reap. */
    replacedGenerationRetentionMs: number;
    /** Deleted-file cleanup (ms): how long a deleted generation's live bytes wait before the cleanup sweep removes them (0 = immediate). */
    deletedFileCleanupMs: number;
    /** Privacy-erasure (ms): the erasure-class deletion wait before live bytes are removed (0 = immediate). */
    privacyErasureMs: number;
    /** Backup-retention (ms): how long retained backups hold generation copies before the bin expiry sweep trims them. */
    backupRetentionMs: number;
  }>>;
  /** Low-disk upload guard (S6/A5 #5): refuse new uploads below this many free bytes (0 disables). */
  blobLowDiskHeadroomBytes?: number;
  /**
   * S1/A6 recycle bin (S6/A5 #4): the adapter-owned root whose `backups/` and
   * `recycle/` directories the recycle manager owns. When set, the app
   * assembles a recycle seam over the SAME blob seams as backup/recovery, so
   * replaced/dangling and deleted generations route through the recycling bin
   * BEFORE live bytes are removed.
   */
  blobRecycle?: Readonly<{ root: string }>;
  operationalConsumers?: readonly OperationalConsumer<unknown, any>[];
  blobLifecycle?: BlobLifecycleOptions;
}

export type PendingBlobKey = string & { readonly __brand: 'PendingBlobKey' };
export type PendingBlobClaim = Readonly<{ pendingKey: PendingBlobKey; claimToken: string & { readonly __brand: 'PendingBlobClaimToken' } }>;
export type ClaimedBlobRef = Readonly<{ blobId: string & { readonly __brand: 'ClaimedBlobId' } }>;
export type DeclaredClaimedBlob = Readonly<{ blobId: ClaimedBlobRef['blobId']; resourceId: string; sha256: string; md5: string; byteLength: number; mediaType: string | null }>;
export type DeclaredClaimedBlobs = Readonly<Record<string, DeclaredClaimedBlob>>;
export type DeclaredBlobField = Readonly<{
  actionName: string;
  field: string;
  resourceField: string;
  purgeActionName?: string;
  /** The resource generation that owns these bytes (S6 #4); required. */
  owningResource: string;
  /** What erasure does with the bytes when the owning generation is removed; required. */
  erasureCategory: 'deletable' | 'retained' | 'derived';
  /** Explicit ownership model; defaults to exclusive. Hash equality never implies sharing (#7). */
  ownership?: 'exclusive' | 'shared';
  /** Lifecycle stage the reference must reach before the bytes are reapable; defaults to finalize. */
  lifecycle?: 'pending' | 'adopt' | 'finalize';
  /** Package-written paths beneath the owning event's data; handlers must leave each leaf absent. */
  canonicalEventMetadata?: Readonly<{ byteLength?: readonly string[]; mediaType?: readonly string[] }>;
}>;
export type BlobLifecycleOptions = Readonly<{ fields: readonly DeclaredBlobField[]; pendingTtlMs: number; adoptedRecoveryTtlMs: number }>;

export type OperationalConsumerName = string & { readonly __brand: 'OperationalConsumerName' };
export type OperationalDeclarationVersion = string & { readonly __brand: 'OperationalDeclarationVersion' };
export type OperationalIdempotencyKey = string & { readonly __brand: 'OperationalIdempotencyKey' };
export type OperationalCommittedMetadata = Readonly<{
  committedEventId: string;
  actionId: string;
  scopeId: string;
  eventType: string;
  committedAt: string;
}>;
export type OperationalEventSpec<TFields extends object, TPayload> = Readonly<{
  eventType: string;
  fields: readonly (keyof TFields)[];
  project(fields: Readonly<TFields>, metadata: OperationalCommittedMetadata): TPayload;
}>;
export function defineOperationalEvent<TFields extends object, TPayload>(spec: OperationalEventSpec<TFields, TPayload>): OperationalEventSpec<TFields, TPayload>;
export type OperationalDelivery<TPayload> = Readonly<{
  metadata: OperationalCommittedMetadata;
  payload: TPayload;
  idempotencyKey: OperationalIdempotencyKey;
}>;
export type OperationalRetry = Readonly<{ kind: 'retry'; afterMs: number }> | Readonly<{ kind: 'terminal'; code: string; detail: string }>;
export type OperationalEffectResult = Readonly<{ kind: 'ack' }> | OperationalRetry;
export type OperationalConsumer<TPayload, TFields extends object = object> = Readonly<{
  name: OperationalConsumerName;
  declarationVersion: OperationalDeclarationVersion;
  projectionId: string;
  effectId: string;
  event: OperationalEventSpec<TFields, TPayload>;
  idempotencyKey(delivery: Readonly<Omit<OperationalDelivery<TPayload>, 'idempotencyKey'>>): OperationalIdempotencyKey;
  handle(delivery: OperationalDelivery<TPayload>): Promise<OperationalEffectResult>;
}>;
export function operationalConsumer<TPayload, TFields extends object>(consumer: OperationalConsumer<TPayload, TFields>): OperationalConsumer<TPayload, TFields>;

export interface OrdinaryRegisteredProjection {
  readonly eventTypes: readonly string[];
  readonly privateFact?: never;
  apply(event: CommittedEvent, db: WorkbenchDatabase, context?: Readonly<{ claimedBlobs?: DeclaredClaimedBlobs }>): void;
}
export interface PrivateFactRegisteredProjection<PrivateFact = { readonly before: unknown; readonly after: unknown }> {
  readonly eventTypes: readonly string[];
  readonly privateFact: true;
  apply(event: CommittedEvent, db: WorkbenchDatabase, context: Readonly<{ privateFact: PrivateFact; claimedBlobs?: DeclaredClaimedBlobs }>): void;
}
export type RegisteredProjection = OrdinaryRegisteredProjection | PrivateFactRegisteredProjection;

export interface ErasureEventTargetV1 {
  readonly scope: string;
  readonly seq: number;
  readonly actionId: string;
  readonly eventType: string;
  readonly committedAt: string;
  readonly eventDataDigest: string;
}
export interface ErasureActionTargetV1 {
  readonly scope: string;
  readonly actionId: string;
  readonly historyOrder: number;
  readonly committedAt: string;
  readonly receiptDigest: string;
  readonly events: readonly ErasureEventTargetV1[];
}
export interface ErasureCensusRuleV1 {
  readonly kind: 'action' | 'event';
  readonly type: string;
  readonly disposition: 'target' | 'retain';
  readonly identityPointers: readonly string[];
}
export interface ErasureDirectiveV1 {
  readonly kind: 'workbench.erasure';
  readonly version: 1;
  readonly owningScope: string;
  readonly subject: string;
  readonly actions: readonly ErasureActionTargetV1[];
  readonly census: { readonly version: 1; readonly rules: readonly ErasureCensusRuleV1[] };
}
export interface ErasureDirectivePreparationV1 {
  readonly kind: 'workbench.erasure.preparation';
  readonly version: 1;
  readonly owningScope: string;
  readonly subject: string;
  readonly census: ErasureDirectiveV1['census'];
}
export interface ErasurePreparationWrites {
  insert(table: string, values: Readonly<Record<string, unknown>>): number | bigint;
  update(table: string, values: Readonly<Record<string, unknown>>, where: Readonly<Record<string, unknown>>): number | bigint;
  delete(table: string, where: Readonly<Record<string, unknown>>): number | bigint;
}
export interface ErasurePreparationReads {
  /** Read matching rows using an AND of bound equality filters. */
  find(table: string, where: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[];
}
export interface ErasurePreparationContext<Payload = Record<string, unknown>> {
  readonly action: Readonly<{
    readonly id: string;
    readonly type: string;
    readonly scope: string;
    readonly operation: 'erasure';
    /** Canonical origin transaction commit timestamp, captured once for this dispatch. */
    readonly committedAt: string;
    readonly payload: Payload;
    readonly principal: Pick<Principal, 'type' | 'id'>;
  }>;
  readonly subject: Readonly<{ readonly owningScope: string; readonly id: string }>;
}
export interface ProtectedArtefactStore {
  /** Insert a row into a declared application-owned protected table, atomically with this action's commit. */
  write(table: string, values: Readonly<Record<string, unknown>>): number | bigint;
  /** Permanently delete rows from a declared protected table by equality predicate, atomically with this action's commit. */
  erase(table: string, where: Readonly<Record<string, unknown>>): number | bigint;
}
export interface RegisteredActionCommit {
  readonly events: readonly Readonly<{ type: string; scope: string; data: unknown }>[];
  /** One descriptor for the action's declared annotated-text operation. */
  readonly annotatedText?: readonly unknown[];
  /** Application-side before/after fact committed with the document operation. */
  readonly applicationTransition?: Readonly<{ before: unknown; after: unknown }>;
  readonly directive?: ErasureDirectiveV1 | ErasureDirectivePreparationV1;
  /**
   * The non-sensitive action identity stored as the receipt's canonical
   * `actionData` instead of the request payload. REQUIRED for an action that
   * declares `protectedArtefacts`: the request payload may carry protected
   * payloads and must never become canonical history.
   */
  readonly canonicalPayload?: unknown;
  readonly privateFact?: { readonly before: unknown; readonly after: unknown };
  readonly effects?: readonly PostCommitEffectDeclaration[];
}
export interface PostCommitEffectDeclaration {
  readonly file: string;
  readonly operation: string;
  readonly key?: string;
  readonly verification: string;
  readonly payload?: unknown;
}
export function postCommitEffect(input: PostCommitEffectDeclaration): Readonly<PostCommitEffectDeclaration>;
export interface AuthorizedRowRequirement {
  readonly entity: string | AnyWorkbenchEntity;
  readonly id: string;
  readonly capability: typeof read | typeof write | typeof subscribe | typeof admin;
}
export function authorizedRows<Payload = Record<string, unknown>>(
  resolve: (context: { payload: Payload; principal: Principal }) => readonly AuthorizedRowRequirement[] | Promise<readonly AuthorizedRowRequirement[]>,
): RegisteredAction<Payload>['authorize'];
export interface PostCommitEffectId {
  readonly scope: string;
  readonly actionId: string;
  readonly file: string;
  readonly operation: string;
  readonly ordinal: number;
}
export interface ClaimedPostCommitEffect {
  readonly id: PostCommitEffectId;
  readonly key: string;
  readonly verification: string;
  readonly payload: unknown;
  readonly fence: number;
  readonly leaseUntil: number;
}
export interface PostCommitEffectRunner {
  claim(workerId: string): ClaimedPostCommitEffect | null;
  heartbeat(id: PostCommitEffectId, workerId: string, fence: number): boolean;
  complete(id: PostCommitEffectId, workerId: string, fence: number, result: { verification: string }): { accepted: boolean; noop?: boolean; verification?: false };
  fail(id: PostCommitEffectId, workerId: string, fence: number, result?: { retryAt?: number }): { accepted: boolean };
  reconstruct(): { inserted: number };
}
export function erasureDirective(input: ErasureDirectiveV1): Readonly<ErasureDirectiveV1>;
export function erasureDirectivePreparation(
  input: Pick<ErasureDirectiveV1, 'owningScope' | 'subject' | 'census'>,
): Readonly<ErasureDirectivePreparationV1>;

export interface RegisteredAction<
  Payload = Record<string, unknown>,
  Projection extends RegisteredProjection = OrdinaryRegisteredProjection,
> {
  readonly type: string;
  authorize(context: {
    type: string;
    payload: Payload;
    principal: Principal;
    db: WorkbenchDatabase;
  }): boolean | Promise<boolean>;
  handler(context: {
    readonly actionId: string;
    payload: Payload;
    principal: Principal;
    db: WorkbenchDatabase;
    now: string;
    /** Exact caller-selected owning scope for this dispatch. */
    readonly scope: string;
    /** Package-attested staged-blob identity and metadata; transaction-bound and never serialized. */
    readonly claimedBlobs?: DeclaredClaimedBlobs;
    /**
     * Transaction-bound write/erase authority over exactly the application-owned
     * tables declared in `protectedArtefacts`. Present only when that declaration
     * exists; the capability closes when the handler returns and its writes roll
     * back with the action on any failure.
     */
     readonly protectedArtefact?: ProtectedArtefactStore;
     /** Host-executed project purge authority; present only for opted-in actions and only in a transaction. */
     readonly ownedResources?: OwnedResources;
    /** Present only for a Workbench-owned inverse/redo dispatch; never serialized. */
    readonly history?: Readonly<{
      readonly operation: 'undo' | 'redo';
      readonly input: unknown;
    }>;
  }): readonly Readonly<{ type: string; scope: string; data: unknown }>[] | RegisteredActionCommit | Promise<readonly Readonly<{ type: string; scope: string; data: unknown }>[] | RegisteredActionCommit>;
  readonly projections?: readonly Projection[];
  readonly history?: { readonly cursor?: 'eligible' | 'excluded' };
  /** At most one declared annotated-text operation, composed atomically with this action. */
  readonly operations?: readonly AnnotatedTextOperationHandle[];
  /**
   * Declared application-owned protected-artefact store. The handler receives a
   * transaction-bound `protectedArtefact` capability restricted to exactly these
   * tables; writes and erasures join the action's own commit and roll back with
   * it. Protected payloads never appear in events, receipts, snapshots, live
   * delivery, undo history, or exports — return a `canonicalPayload` containing
   * only the IDs/provenance needed to reference each artefact (required). Erase
   * permanently hard-deletes the declared rows. Requires single dispatch.
   */
  readonly protectedArtefacts?: Readonly<{ tables: readonly string[] }>;
  /** Opt into the transaction-bound host execution of registered plugin purge plans. */
  readonly ownedResources?: true;
  /** Privileged durable-pipeline erasure directive; requires history.cursor excluded. */
  readonly erasure?: true | Readonly<{
    /** Exact application-owned tables the preparation callback may mutate. */
    tables: readonly string[];
    /** Exact application-owned tables the preparation callback may query. */
    readTables?: readonly string[];
    /** Runs once inside the origin transaction, after exact manifest validation and before erasure. */
    prepare(context: Readonly<{
      /** Transaction-bound, write-only access to application-owned tables. */
      writes: ErasurePreparationWrites;
      /** Transaction-bound equality reads over explicitly declared application tables. */
      reads: ErasurePreparationReads;
      manifest: Readonly<ErasureDirectiveV1>;
      /** Canonical, non-persisted identity of the originating erasure action and declared subject. */
      context: Readonly<ErasurePreparationContext<Payload>>;
    }>): void | Promise<void>;
  }>;
}

/** Serializes all application writes and drains them during shutdown. */
export interface WriteQueue {
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
  readonly depth: number;
  readonly running: boolean;
  readonly closed: boolean;
  /** True when the current async context holds this queue's writer slot. This does not start a SQLite transaction. */
  readonly owned: boolean;
}

/**
 * Controlled, read-only connection description for external readers (S1/A5).
 * Open it with `openReadMirror`, which enforces read-only at the engine
 * (`mode=ro`) AND via a query-class rejector. It never carries a write path.
 */
export interface ReadMirrorDescription {
  readonly kind: 'read-mirror';
  readonly mode: 'read-only';
  readonly readOnly: true;
  readonly connectionString: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

/** The opened read-mirror surface: `prepare`/`exec` are rejector-wrapped; no raw engine handle is exposed. */
export interface ReadMirrorHandle {
  prepare(sql: string): { run(...args: unknown[]): { changes: number }; get(...args: unknown[]): Record<string, unknown> | undefined; all(...args: unknown[]): Record<string, unknown>[] };
  exec(sql: string): unknown;
  close(): void;
}

/** A statement class a read-mirror rejector refuses (`write`/`ddl`/`pragma` mutations). */
export type ReadMirrorStatementKind = 'read' | 'write' | 'ddl' | 'pragma' | 'transaction' | 'refuse';

export class ReadMirrorError extends Error {
  readonly code: 'WB_READ_MIRROR_REFUSED';
  readonly kind: Exclude<ReadMirrorStatementKind, 'read'>;
}

/** Open a read-mirror description as a rejector-wrapped, engine-read-only connection. */
export function openReadMirror(description: ReadMirrorDescription): ReadMirrorHandle;

export interface WorkbenchApp extends RouteBuilder {
  readonly db?: WorkbenchDatabase;
  readonly routes: readonly unknown[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly entities: ReadonlyMap<string, AnyWorkbenchEntity>;
  readonly actions: readonly RegisteredAction<any, RegisteredProjection>[];
  readonly log: WorkbenchLog;
  readonly clock: WorkbenchClock;
  readonly writeQueue: WriteQueue;
  /** The platform write coordinator (S1/A5) — the same object as `writeQueue`; every write category enters through it. */
  readonly writeCoordinator: WriteQueue;
  /** Whether package-owned live delivery is attached, plus its transport-neutral test seam. */
  readonly delivery: ApplicationDelivery;
  /** Controlled read-only description for external readers; throws fail-closed on a raw-handle app. */
  readMirror(): ReadMirrorDescription;
  /**
   * Shared-state PRAGMA maintenance seam (S1/A5): runs `fn` with
   * `foreign_keys = OFF` inside one coordinated write turn and restores `ON`
   * in a finally even when `fn` throws. The sole route for shared-state PRAGMA
   * toggles.
   */
  withForeignKeysDisabled<T>(fn: () => Promise<T> | T): Promise<T>;
  readonly port?: number;
  readonly httpServer?: Server;
  readonly jobs?: unknown;
  readonly postCommitEffects?: PostCommitEffectRunner;
  readonly blobs?: unknown;
  readonly principalSnapshots?: PrincipalSnapshotTransactionApi;
  readonly history?: DurableHistoryRuntime;
  /** Registered server-side search plugins and their lifecycle state. */
  readonly searchPlugins: SearchPluginRegistry;
  resolveScope?: WorkbenchOptions['resolveScope'];
  scopeSnapshot?: WorkbenchOptions['scopeSnapshot'];
  readonly ready?: Promise<WorkbenchApp>;
  mount(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  use(path: string, target: EntityTarget | RouteBuilder | Handler): this;
  entity<Row extends object>(declaration: WorkbenchEntity<Row>): BoundWorkbenchEntity<Row>;
  entity<Row extends object = Record<string, unknown>>(name: string): BoundWorkbenchEntity<Row>;
  /** Register a search plugin before the app starts; returns this app for chaining. */
  registerSearchPlugin(plugin: SearchPlugin): this;
  register(...declarations: readonly (WorkbenchEntity | readonly WorkbenchEntity[])[]): this;
  auth(options?: { identifyBy?: readonly string[] }): this;
  static(prefix: string, directory: string, options?: import('./src/server.js').ServeStaticOptions): this;
  prepareSchema(): Promise<this>;
  ddl(): Promise<this>;
  /** Attach package-owned HTTP/SSE delivery to this app before start or listen. */
  attachLiveDelivery(options: AppLiveDeliveryOptions): this;
  start(): Promise<this>;
  /** Close an unstarted database synchronously; rejects after startup begins. */
  releaseUnstartedDatabase(): this;
  onShutdown(
    name: string,
    hook: () => void | Promise<void>,
    options?: { timeoutMs?: number },
  ): void;
  shutdown(): Promise<void>;
  dispatch<Payload = Record<string, unknown>>(
    request: DispatchRequest<Payload>,
  ): Promise<DispatchResult>;
  /** Rebuild explicitly private-fact projections from private facts and receipt event references. */
  replayPrivateFactProjections(): Promise<{ projected: number }>;
  batch<Action extends BatchAction>(
    actions: readonly Action[] | BatchActionFactory<Action>,
    options?: { principal?: Principal; clientId?: string; scope?: string },
  ): Promise<DispatchResult>;
  listen(): this;
  listen(callback: () => void): this;
  listen(options: ListenOptions): this;
  listen(port: number, callback?: () => void): this;
  listen(port: number, options: ListenOptions): this;
}

export function router(options?: { mergeParams?: boolean }): RouteBuilder;

export type HistoryOperation = 'read' | 'undo' | 'redo';

export interface HistoryAction {
  readonly scope: string;
  readonly order: number;
  readonly actionId: string;
  readonly type: string | null;
  readonly payload: unknown;
  readonly principal: string | null;
  readonly session: string | null;
  readonly operation: 'action' | 'undo' | 'redo';
  readonly committedAt: string;
  readonly events: readonly CommittedEvent[];
}

export interface HistoryAccess {
  readonly operation: HistoryOperation;
  readonly scope: string;
  readonly principal: Principal;
  readonly session?: string;
  readonly action?: HistoryAction;
}

export interface HistoryActionRequest<Payload = Record<string, unknown>, Input = unknown> {
  readonly type: string;
  readonly payload?: Payload;
  readonly scope?: string;
  /** Opaque transaction-bound handler input. Workbench never serializes this value. */
  readonly input?: Input;
}

export interface HistoryActionBatchRequest {
  readonly actions: readonly HistoryActionRequest[];
}

export type HistoryTranslationRequest = HistoryActionRequest | HistoryActionBatchRequest;

export interface DurableHistoryDescriptor {
  readonly authorize: (access: HistoryAccess) => boolean | Promise<boolean>;
  readonly actions: Readonly<Record<string, Readonly<{
    readonly inverse: (context: {
    readonly action: HistoryAction;
    /** Canonical erasure-aware material, supplied only to server-side translation. */
    readonly fact: Readonly<{ readonly before: unknown; readonly after: unknown }>;
    readonly principal: Principal;
    readonly session: string;
  }) => HistoryTranslationRequest | Promise<HistoryTranslationRequest>;
    readonly redo: (context: {
    readonly action: HistoryAction;
    /** Canonical erasure-aware material, supplied only to server-side translation. */
    readonly fact: Readonly<{ readonly before: unknown; readonly after: unknown }>;
    readonly principal: Principal;
    readonly session: string;
  }) => HistoryTranslationRequest | Promise<HistoryTranslationRequest>;
  }>>>;
}

export function durableHistory(options: DurableHistoryDescriptor): DurableHistoryDescriptor;

export interface HistorySessionOptions {
  readonly scope: string;
  readonly session: string;
  readonly principal: Principal;
  /** Stable retry identity. Required for mutation; omitted only by cursor reads. */
  readonly actionId: string;
  /** Cursor revision returned by cursor(); stale revisions fail with conflict. */
  readonly revision: string;
}

export interface DurableHistoryRuntime {
  cursor(options: Omit<HistorySessionOptions, 'actionId' | 'revision'>): Promise<Readonly<{ undo: number; redo: number; revision: string }>>;
  undo(options: HistorySessionOptions): Promise<DispatchResult & { readonly empty?: boolean }>;
  redo(options: HistorySessionOptions): Promise<DispatchResult & { readonly empty?: boolean }>;
}

export const User: WorkbenchEntity;
export const Session: WorkbenchEntity;
export const Inbox: WorkbenchEntity;
export const Credential: WorkbenchEntity;
export const Invitation: WorkbenchEntity;
export const ApiKey: WorkbenchEntity;
export const TwoFactor: WorkbenchEntity;

// These helpers are runtime exports of the root module as well as the
// `workbench/server` entry point. Re-export their declarations so both import
// paths describe the same public API.
export {
  SESSION_COOKIE,
  apiKeyPrincipalOf,
  createInvitationApi,
  emailSeam,
  matchRoute,
  noopTransport,
  parseCookies,
  serveStatic,
  sessionCookie,
  sessionPrincipalOf,
  sessionTokenOf,
} from './src/server.js';
export type {
  EmailMessage,
  EmailSeam,
  EmailTransport,
  InvitationApi,
  Invitation as InvitationRecord,
  ServeStaticOptions,
} from './src/server.js';

export interface LogRetentionReport {
  cutoffIso: string;
  retentionDays: number;
  log: { totalRows: number; totalBytes: number; rowsPruned: number; bytesPruned: number; oldestCommittedAt: string | null };
  receipt: { totalRows: number; rowsExpired: number; actionDataBytesNulled: number; resultDataBytesRetained: number };
  privateActionFact: { rowsPruned: number; bytesPruned: number };
}
export function logRetentionReport(db: WorkbenchDatabase, retentionDays: number, nowMs?: number): LogRetentionReport;

export default function workbench(options?: WorkbenchOptions): WorkbenchApp;
