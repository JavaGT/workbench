// Package-owned browser transport for registered actions and explicitly
// opted-in generated entity CRUD. It deliberately accepts one opaque envelope
// instead of exposing entity-specific REST writes.

import { BodyError, readRequestBody } from './http-body.ts';
import { failure, isWorkbenchFailure, type WorkbenchFailure } from './outcome.ts';
import { sendFailure, type SendJson } from './http-failure.ts';
import { annotatedTextHistorySession, resolveAnnotatedTextOwningScope } from './annotated-text-field.ts';
import { scopeOf } from './scope-handle.ts';
import { rawRow } from './entity/query.ts';
import type { HttpResponseLike } from './http-response.ts';
import type { Principal } from './principal.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';
import type { Gate } from './route-gate.ts';

const ACTION_PATH = '/workbench/actions';
const BATCH_ACTION_PATH = '/workbench/actions/batch';
const HISTORY_PATH = '/workbench/history';
const MAX_STRING_LENGTH = 512;
const historyHttpDispatchers = new WeakMap<ApplicationApp, (command: unknown, args: unknown) => Promise<DispatchResult>>();
const batchHttpDispatchers = new WeakMap<ApplicationApp, (args: unknown) => Promise<DispatchResult>>();
const APPLICATION_HTTP_CRUD_VERBS = new Set<string>(['create', 'update', 'remove']);

// The loose application surface this transport reads: the entity registry, the
// db for owner-scope resolution, and the kernel dispatch path. The app module
// owns the full shape; only these seams are consumed here.
export interface AppEntityField {
  kind?: string;
  type?: string;
  [key: string]: unknown;
}

export interface AppEntity {
  name: string;
  fields?: Readonly<Record<string, AppEntityField>>;
  applicationHttpActions?: readonly string[];
  crudHandlers?: Record<string, unknown>;
  inherit?: { parent: string; via: string };
  gate?: Readonly<Record<string, (principal: unknown) => boolean>>;
  [key: string]: unknown;
}

export interface AppDb {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
}

export interface DispatchResult {
  ok?: boolean;
  failure?: WorkbenchFailure;
  resultData?: unknown;
}

export interface ApplicationApp {
  actions?: readonly { type?: string }[];
  entities?: ReadonlyMap<string, AppEntity>;
  db?: AppDb;
  dispatch(args: unknown): Promise<DispatchResult>;
  history?: unknown;
  log?: { error?(channel: string, message: string, ctx?: Record<string, unknown>): void };
  _applicationLiveDelivery?: { wake(scope: string | undefined): unknown };
  _authorization?: AuthorizationAdapter | null;
  [key: string]: unknown;
}

interface DocumentIdentity {
  entity: string;
  field: string;
  documentId: string;
  authoringClient?: string | null;
  viewAs?: string | null;
}

interface BatchAction {
  type: string;
  payload: unknown;
}

interface ActionRequest {
  actionId: string;
  type: string;
  payload: unknown;
  scope?: string;
  document?: DocumentIdentity;
  clientId?: string;
}

interface BatchActionRequest {
  actionId: string;
  scope?: string;
  document?: DocumentIdentity;
  actions: readonly BatchAction[];
  clientId?: string;
}

interface HistoryRequest {
  actionId: string;
  scope?: string;
  document?: DocumentIdentity;
  session: string;
}

// The union of validators' outputs as the admission/gate layer sees it. Every
// field is optional here because the shape varies per endpoint; the validators
// above guarantee the fields a given path actually consumes.
interface NormalizedRequest {
  actionId: string;
  type?: string;
  payload?: unknown;
  scope?: string;
  document?: DocumentIdentity;
  clientId?: string;
  session?: string;
  actions?: readonly BatchAction[];
}

interface AdmittableAction {
  type?: string;
  payload?: unknown;
  scope?: string;
}

interface ActionHttpRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  aborted?: boolean;
  destroyed?: boolean;
}

export function installHistoryHttpDispatcher(
  app: ApplicationApp,
  dispatch: (command: unknown, args: unknown) => Promise<DispatchResult>,
): void {
  historyHttpDispatchers.set(app, dispatch);
}

export function installBatchHttpDispatcher(
  app: ApplicationApp,
  dispatch: (args: unknown) => Promise<DispatchResult>,
): void {
  batchHttpDispatchers.set(app, dispatch);
}

function isJsonValue(value: unknown, ancestors = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function actionRequest(body: unknown): ActionRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length < 3 || keys.length > 6 || keys.some((key) => !['actionId', 'scope', 'document', 'type', 'payload', 'clientId'].includes(key))) return null;
  const { actionId, scope, document, type, payload, clientId } = record;
  if (![actionId, type].every((value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH)) return null;
  if (scope !== undefined && (typeof scope !== 'string' || scope.length === 0 || scope.length > MAX_STRING_LENGTH)) return null;
  if (document !== undefined && !validDocumentIdentity(document)) return null;
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > MAX_STRING_LENGTH)) return null;
  if (!isJsonValue(payload)) return null;
  return {
    actionId,
    ...(scope === undefined ? {} : { scope }),
    ...(document === undefined ? {} : { document }),
    type,
    payload,
    ...(clientId === undefined ? {} : { clientId }),
  } as ActionRequest;
}

function validDocumentIdentity(document: unknown): boolean {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  const record = document as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['entity', 'field', 'documentId', 'authoringClient', 'viewAs'].includes(key))) return false;
  if (!['entity', 'field', 'documentId'].every((key) => typeof record[key] === 'string' && (record[key] as string).length > 0)) return false;
  if (record.authoringClient !== undefined && record.authoringClient !== null && (typeof record.authoringClient !== 'string' || (record.authoringClient as string).length === 0)) return false;
  if (record.viewAs !== undefined && record.viewAs !== null && typeof record.viewAs !== 'string') return false;
  return true;
}

function batchActionRequest(body: unknown): BatchActionRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length < 3 || keys.length > 5 || keys.some((key) => !['actionId', 'scope', 'document', 'actions', 'clientId'].includes(key))) return null;
  const { actionId, scope, document, actions, clientId } = record;
  if (typeof actionId !== 'string' || actionId.length === 0 || actionId.length > MAX_STRING_LENGTH) return null;
  if (scope === undefined && document === undefined) return null;
  if (scope !== undefined && (typeof scope !== 'string' || scope.length === 0 || scope.length > MAX_STRING_LENGTH)) return null;
  if (document !== undefined && !validDocumentIdentity(document)) return null;
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > MAX_STRING_LENGTH)) return null;
  if (!Array.isArray(actions) || actions.length === 0 || actions.some((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action) || Object.keys(action).length !== 2) return true;
    const actionRecord = action as Record<string, unknown>;
    return typeof actionRecord.type !== 'string' || (actionRecord.type as string).length === 0 || (actionRecord.type as string).length > MAX_STRING_LENGTH || !isJsonValue(actionRecord.payload);
  })) return null;
  return {
    actionId,
    ...(scope === undefined ? {} : { scope }),
    ...(document === undefined ? {} : { document }),
    actions: actions as readonly BatchAction[],
    ...(clientId === undefined ? {} : { clientId }),
  } as BatchActionRequest;
}

function validPrincipal(principal: unknown): principal is Principal {
  const record = principal as { type?: unknown; id?: unknown } | null | undefined;
  return !!record
    && typeof record.type === 'string'
    && typeof record.id === 'string'
    && record.type !== 'anonymous';
}

function historyRequest(body: unknown): HistoryRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const { actionId, scope, document, session, command } = record;
  const allowed = ['actionId', 'scope', 'document', 'session', 'command'];
  if (Object.keys(record).some((key) => !allowed.includes(key)) || (scope === undefined) === (document === undefined)) return null;
  if (!['undo', 'redo'].includes(command as string)
    || ![actionId, session].every((value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH)) return null;
  if (scope !== undefined && (typeof scope !== 'string' || !scope || scope.length > MAX_STRING_LENGTH)) return null;
  if (document !== undefined && !validDocumentIdentity(document)) return null;
  return {
    actionId,
    ...(scope === undefined ? {} : { scope }),
    ...(document === undefined ? {} : { document }),
    session,
  } as HistoryRequest;
}

function resolveDocumentScope(app: ApplicationApp, document: DocumentIdentity): string | null {
  if (!document) return null;
  const entity = app.entities?.get(document.entity);
  const descriptor = entity?.fields?.[document.field];
  if (!entity || descriptor?.kind !== 'annotatedText') return null;
  const row = rawRow(app.db!, entity.name, document.documentId);
  if (!row) return null;
  try { return resolveAnnotatedTextOwningScope(descriptor, entity.fields as Record<string, any>, row as Record<string, any>).key; } catch { return null; }
}

function annotatedTextActionIdentity(app: ApplicationApp, request: AdmittableAction): DocumentIdentity | null {
  const id = (request.payload as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  for (const entity of app.entities!.values()) {
    for (const [field, descriptor] of Object.entries(entity.fields ?? ({} as Record<string, AppEntityField>))) {
      if (descriptor.kind === 'annotatedText' && request.type === `${entity.name}.${field}.operation`) {
        const row = app.db!.prepare(`SELECT 1 FROM ${entity.name} WHERE id = ?`).get(id);
        return row ? { entity: entity.name, field, documentId: id } : null;
      }
    }
  }
  // scope#992 W2: a registered composed action derives its document identity
  // from its declared annotated operation handle (document-local cursor
  // isolation) — same document identity as the native operation path.
  for (const action of app.actions ?? []) {
    const declared = action as { type?: unknown; operations?: Array<{ entity?: unknown; field?: unknown }> };
    if (declared.type !== request.type) continue;
    const handle = Array.isArray(declared.operations) ? declared.operations[0] : null;
    if (!handle || typeof handle.entity !== 'string' || typeof handle.field !== 'string') continue;
    const entity = app.entities?.get(handle.entity);
    if (entity?.fields?.[handle.field]?.kind !== 'annotatedText') continue;
    const row = app.db!.prepare(`SELECT 1 FROM ${handle.entity} WHERE id = ?`).get(id);
    return row ? { entity: handle.entity, field: handle.field, documentId: id } : null;
  }
  return null;
}

function parseGeneratedCrudType(type: string): { entityName: string; verb: string } | null {
  const dot = type.lastIndexOf('.');
  if (dot <= 0 || dot === type.length - 1) return null;
  const verb = type.slice(dot + 1);
  if (!APPLICATION_HTTP_CRUD_VERBS.has(verb)) return null;
  return { entityName: type.slice(0, dot), verb };
}

function resolveInheritedOwnerScope(app: ApplicationApp, entity: AppEntity, verb: string, payload: unknown): string | null {
  const inherit = entity.inherit;
  if (!inherit) return null;
  const payloadRecord = payload as Record<string, unknown> | null | undefined;
  if (verb === 'create') {
    const ownerId = payloadRecord?.[inherit.via];
    if (typeof ownerId !== 'string' || ownerId.length === 0) return null;
    return scopeOf(inherit.parent, ownerId).key;
  }
  const id = payloadRecord?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const row = rawRow(app.db!, entity.name, id);
  if (!row) return null;
  const ownerId = (row as Record<string, unknown>)[inherit.via];
  if (typeof ownerId !== 'string' || ownerId.length === 0) return null;
  if (Object.hasOwn(payloadRecord ?? {}, inherit.via) && payloadRecord?.[inherit.via] !== ownerId) return null;
  return scopeOf(inherit.parent, ownerId).key;
}

function admitsAnnotatedTextAction(app: ApplicationApp, request: AdmittableAction): boolean {
  for (const entity of app.entities!.values()) {
    const annotatedEntries = Object.entries(entity.fields ?? ({} as Record<string, AppEntityField>))
      .filter(([, field]) => field.kind === 'annotatedText');
    const annotatedFields = annotatedEntries.map(([name]) => name);
    if (annotatedFields.length === 0) continue;
    const isCreate = request.type === `${entity.name}.create`;
    const isRetire = request.type === `${entity.name}.annotatedText.retire`;
    const isOperation = (request.payload as { version?: unknown } | null | undefined)?.version === 9
      && annotatedFields.some((field) => request.type === `${entity.name}.${field}.operation`);
    if (!isCreate && !isRetire && !isOperation) continue;
    const id = (request.payload as { id?: unknown } | null | undefined)?.id;
    if (typeof id !== 'string' || id.length === 0) return false;
    let owningScope: string | undefined;
    if (isCreate) {
      try { owningScope = resolveAnnotatedTextOwningScope(annotatedEntries[0][1], entity.fields as Record<string, any>, request.payload as Record<string, any>).key; } catch { return false; }
    } else {
      const row = rawRow(app.db!, entity.name, id);
      if (!row) return false;
      owningScope = resolveAnnotatedTextOwningScope(annotatedEntries[0][1], entity.fields as Record<string, any>, row as Record<string, any>).key;
    }
    // Project-shell sessions always send their subscribed scope. Generated
    // document actions may accept it only when it is the declared owner scope.
    if (request.scope !== undefined && request.scope !== owningScope) return false;
    request.scope = owningScope;
    return true;
  }
  return false;
}

function admitsGeneratedCrudAction(app: ApplicationApp, request: AdmittableAction): boolean {
  const parsed = parseGeneratedCrudType(request.type ?? '');
  if (!parsed) return false;
  const entity = app.entities?.get(parsed.entityName);
  if (!entity) return false;
  if (!entity.applicationHttpActions?.includes(parsed.verb)) return false;
  if (!entity.crudHandlers?.[request.type as string]) return false;
  const owningScope = resolveInheritedOwnerScope(app, entity, parsed.verb, request.payload);
  if (!owningScope) return false;
  if (request.scope === undefined || request.scope !== owningScope) return false;
  return true;
}

/** Single admission predicate for registered, opted-in CRUD, and annotated-text actions. */
export function admitsApplicationHttpAction(app: ApplicationApp, request: AdmittableAction): boolean {
  if (app.actions?.some((action) => action.type === request.type)) return true;
  if (admitsGeneratedCrudAction(app, request)) return true;
  for (const entity of app.entities?.values() ?? []) for (const [fieldName, field] of Object.entries(entity.fields ?? {})) {
    if ((field as any).kind !== 'annotatedText') continue;
    for (const annotation of (field as any).annotations ?? []) for (const actionName of Object.keys(annotation.actions ?? {})) {
      if (request.type === `${entity.name}.${fieldName}.${annotation.annotationName}.${actionName}`) return true;
    }
  }
  return admitsAnnotatedTextAction(app, request);
}

async function routeGateDenies(app: ApplicationApp, request: AdmittableAction, principal: Principal): Promise<boolean> {
  const parsed = parseGeneratedCrudType(request.type ?? '');
  if (!parsed) return false;
  const entity = app.entities?.get(parsed.entityName);
  if (!entity?.applicationHttpActions?.includes(parsed.verb)) return false;
  const gate = entity.gate?.[parsed.verb];
  if (typeof gate !== 'function') return true;
  if (!app._authorization) return !gate(principal);
  try {
    const decision = await app._authorization.admit({
      category: 'principal',
      operation: parsed.verb,
      principal,
      gate: gate as unknown as Gate,
    });
    return !decision.admitted;
  } catch {
    return true;
  }
}

export interface PrincipalOf {
  (req: unknown, hint?: { viewAs?: unknown }): Promise<Principal> | Principal;
}

/** Handle the fixed HTTP skin for application-registered actions. */
export async function handleApplicationActionHttp(
  app: ApplicationApp,
  req: ActionHttpRequest,
  res: HttpResponseLike,
  principalOf: PrincipalOf,
  sendJson: SendJson,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://workbench.local');
  if (url.pathname !== ACTION_PATH && url.pathname !== BATCH_ACTION_PATH && url.pathname !== HISTORY_PATH) return false;
  if (req.method !== 'POST') {
    sendFailure(sendJson, res, failure('invalid-input', 'method not allowed'), { status: 405 });
    return true;
  }

  let body: unknown;
  try {
    body = await readRequestBody(req, { jsonOnly: true });
  } catch (error) {
    if (error instanceof BodyError) {
      sendFailure(sendJson, res, failure('invalid-input', error.message), { status: error.status });
      return true;
    }
    throw error;
  }
  const request: NormalizedRequest | null = url.pathname === HISTORY_PATH ? historyRequest(body)
    : url.pathname === BATCH_ACTION_PATH ? batchActionRequest(body) : actionRequest(body);
  if (!request) {
    sendFailure(sendJson, res, failure('invalid-input', 'invalid action request'));
    return true;
  }
  let principal: Principal;
  // The second argument is a demo-only principal hint carried in the client's
  // document identity (the annotated-doc view-as toggle). The real authorization
  // path (sessionPrincipalOf) ignores it and resolves the principal server-side;
  // only demo-style `principalOf` implementations may read it. Never authorize a
  // mutation on client-supplied identity.
  try { principal = await principalOf(req, { viewAs: request.document?.viewAs ?? null }); } catch {
    sendFailure(sendJson, res, failure('denied', 'authentication required'));
    return true;
  }
  if (!validPrincipal(principal)) {
    sendFailure(sendJson, res, failure('denied', 'authentication required'));
    return true;
  }

  if (request.document) {
    const document = request.document;
    const scope = resolveDocumentScope(app, document);
    if (!scope) {
      sendFailure(sendJson, res, failure('not-found', 'document is unavailable'));
      return true;
    }
    request.scope = scope;
    if (url.pathname === HISTORY_PATH) {
      request.session = annotatedTextHistorySession(request.session as string, document);
    }
    delete request.document;
  }
  // Registered declarations and explicit applicationHttpActions form the public
  // mutation contract. Kernel handler existence alone never admits a type.
  if (url.pathname === ACTION_PATH && !admitsApplicationHttpAction(app, request)) {
    sendFailure(sendJson, res, failure('unknown-action', 'action is not available'));
    return true;
  }
  if (url.pathname === BATCH_ACTION_PATH
    && request.actions!.some((action) => !admitsApplicationHttpAction(app, { ...action, scope: request.scope }))) {
    sendFailure(sendJson, res, failure('unknown-action', 'batch action is not available'));
    return true;
  }

  if (url.pathname === ACTION_PATH && await routeGateDenies(app, request, principal)) {
    sendFailure(sendJson, res, failure('denied', 'forbidden'));
    return true;
  }
  if (url.pathname === BATCH_ACTION_PATH
    && (await Promise.all(request.actions!.map((action) => routeGateDenies(app, { ...action, scope: request.scope }, principal)))).some(Boolean)) {
    sendFailure(sendJson, res, failure('denied', 'forbidden'));
    return true;
  }

  if (url.pathname === HISTORY_PATH && !app.history) {
    sendFailure(sendJson, res, failure('unknown-action', 'history is not available'));
    return true;
  }
  const result: DispatchResult | undefined = url.pathname === HISTORY_PATH
    ? await historyHttpDispatchers.get(app)?.((body as { command?: unknown }).command, { ...request, principal })
    : url.pathname === BATCH_ACTION_PATH
      ? await batchHttpDispatchers.get(app)?.({ ...request, principal, ...(request.clientId === undefined ? {} : { history: { session: request.clientId } }) })
       : await app.dispatch({ ...request, principal, ...(request.clientId === undefined ? {} : {
           history: {
             session: request.clientId,
             ...(() => {
               const document = annotatedTextActionIdentity(app, request);
               return document ? { identity: annotatedTextHistorySession(request.clientId, document) } : {};
             })(),
           },
         }) });
  if (!result?.ok) {
    app.log?.error?.('action', 'application action rejected', {
      actionId: request.actionId,
      type: request.type,
      message: isWorkbenchFailure(result?.failure) ? result.failure.message : 'Internal error.',
    });
    sendFailure(sendJson, res, isWorkbenchFailure(result?.failure)
      ? result.failure
      : failure('internal', 'Internal error.'));
    return true;
  }

  app._applicationLiveDelivery?.wake(request.scope);
  const receipt = result.resultData as { actionId?: unknown; confirmedThrough?: unknown; authoring?: unknown } | null | undefined;
  if (!receipt || receipt.actionId !== request.actionId || !Number.isSafeInteger(receipt.confirmedThrough)) {
    sendFailure(sendJson, res, failure('internal', 'Action receipt is unavailable.'));
    return true;
  }
  const publicReceipt = receipt.authoring
    ? receipt
    : { actionId: receipt.actionId, confirmedThrough: receipt.confirmedThrough };
  sendJson(res, 200, { ok: true, ...publicReceipt });
  return true;
}

export { ACTION_PATH, BATCH_ACTION_PATH, HISTORY_PATH };
