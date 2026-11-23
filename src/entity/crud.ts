// Entity CRUD handler generation — the mutation handlers for create, update,
// and remove, extracted from the entity compiler so the compiler stays focused
// on validation and assembly, not handler bodies.
//
// createCrudHandlers builds the { `${name}.create`, `${name}.update`,
// `${name}.remove` } handlers that turn an authorized action payload into
// emitted lifecycle events. Side-table mutation handlers (map.add, log.append,
// etc.) are delegated to the side-table strategy, and annotatedText CRUD
// handlers are delegated to `annotated-text-crud.ts`, keeping the CRUD
// generator focused on the entity-row lifecycle.

import { randomUUID } from 'node:crypto';
import {
  validateMaterializedField,
  validateMutation,
  ValidationError,
  deserializeField,
  serializeField,
  flattenStruct,
} from '../field-strategy.ts';
import { scopeOf } from '../scope-handle.ts';
import * as eventHandles from '../event-handle.ts';
import { canonicalTextOp } from '../annotated-text.ts';
import { resolveAnnotatedTextOwningScope } from '../annotated-text-field.ts';
import { CASCADE_DESCENDANT, CASCADE_PREAUTHORIZED } from './removal-cascade.ts';
import { admitRow } from '../row-grant.ts';
import { admitRowTransition } from '../field-admission.ts';
import { admitsInvitationRemoval, admitInvitationAcceptance } from '../auth/invitation-acceptance-authority.ts';
import { rawRow } from './query.ts';
import {
  ANNOTATED_COMPENSATION_INPUT,
  assertV9AnnotatedTextOffsetEditPayload,
  attachAnnotatedTextCreateMetadata,
  createdAnnotationFromMarker,
  extractAnnotatedTextCreateImports,
  registerAnnotatedTextCrudHandlers,
} from '../annotated-text-crud.ts';

export const CRUD_CURSOR_POLICY = Symbol('workbench.crud-cursor-policy');
export {
  ANNOTATED_COMPENSATION_INPUT,
  assertV9AnnotatedTextOffsetEditPayload,
  createdAnnotationFromMarker,
};

/** Prefer the dispatch scope when it is the inherited parent shell for this row. */
export function resolveGeneratedEventScope(record: any, { id, row, payload, scope }: any) {
  const inherit = record.inherit;
  if (inherit && typeof scope === 'string' && scope.length > 0) {
    const ownerId = row?.[inherit.via] ?? payload?.[inherit.via];
    if (typeof ownerId === 'string' && ownerId.length > 0 && scope === scopeOf(inherit.parent, ownerId).key) {
      return scope;
    }
  }
  if (Object.values(record.fields).some((descriptor: any) => descriptor.kind === 'annotatedText')) {
    const annotated = Object.entries(record.fields).find(([, descriptor]: [string, any]) => descriptor.kind === 'annotatedText');
    return resolveAnnotatedTextOwningScope(annotated![1], record.fields, row ?? payload ?? {}).key;
  }
  return scopeOf(record.name, id).key;
}

function ownerFieldOf(entity: any) {
  for (const [fieldName, descriptor] of Object.entries(entity.fields) as Array<[string, any]>) {
    if (descriptor.type === 'ref' && descriptor.role && descriptor.readonly) {
      return fieldName;
    }
  }
  return null;
}

function materializeDefault(defaultValue: any) {
  const value = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

export function materializeCreateDefaults(record: any, payload: any) {
  const data = { ...payload };
  for (const [fieldName, descriptor] of Object.entries(record.fields) as Array<[string, any]>) {
    if (!(fieldName in data) && descriptor.default !== undefined) {
      data[fieldName] = materializeDefault(descriptor.default);
      data[fieldName] = validateMaterializedField(record, fieldName, data[fieldName]);
    }
  }
  return data;
}

export function createCrudHandlers({ record, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }: {
  record: any;
  sideTableStrategyEntries: any[];
  conditionalHistory?: boolean;
  conditionalCreateHistory?: boolean;
}) {
  const { name, fields, verbs } = record;
  const ownerField = ownerFieldOf({ name, fields });

  const handlers: Record<string, any> = {
    [`${name}.create`]: ({ payload, principal, db, history, scope }: any) => {
      if (Object.hasOwn(payload, '__workbench')) {
        throw new ValidationError(`${name}.__workbench is reserved for framework event metadata`);
      }
      const { id: requestedId, ...fieldsPayload } = payload;
      const annotatedImports = extractAnnotatedTextCreateImports(name, fields, fieldsPayload);
      for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
        if (descriptor.kind === 'crdt' && descriptor.type === 'text' && fieldName in fieldsPayload) {
          throw new ValidationError(`${name}.${fieldName} accepts native operations only; create the row then dispatch ${name}.${fieldName}.apply`);
        }
      }
      const validatedFields = validateMutation(record, fieldsPayload);
      if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId.length === 0)) {
        throw new ValidationError(`${name}.id: expected a non-empty text id`);
      }
      const id = requestedId ?? randomUUID();
      if (history) {
        if (!conditionalCreateHistory || history.operation !== 'redo' || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.create history input is invalid`);
        const replacement = history.input.replacement;
        if (history.input.expected !== null || !replacement || replacement.id !== id) throw new ValidationError(`${name}.create history input rows are invalid`);
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
        if (Object.keys(replacement).length !== columns.length || columns.some((column: any) => !Object.hasOwn(replacement, column)) || db.prepare(`SELECT 1 FROM ${name} WHERE id = ?`).get(id)) {
          throw Object.assign(new Error(`${name}.create history expected row conflicts`), { status: 409 });
        }
        const restored: Record<string, any> = { id };
        for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) restored[fieldName] = deserializeField(descriptor, replacement[fieldName]);
        return { events: [{ handle: verbs.created.handle, type: verbs.created.type, scope: resolveGeneratedEventScope(record, { id, payload: replacement, scope }), data: restored }], privateFact: { before: null, after: replacement } };
      }
      const data = materializeCreateDefaults(record, { ...validatedFields, id });
      if (ownerField) data[ownerField] = principal?.id;
      attachAnnotatedTextCreateMetadata(fields, annotatedImports, data);
      const events = [{
        handle: verbs.created.handle,
        type: verbs.created.type,
        scope: resolveGeneratedEventScope(record, { id, payload: data, scope }),
        data,
      }];
      if (!conditionalCreateHistory) return events;
      // The durable fact must be complete before it is stored; projections cannot
      // repair an already-persisted private fact after the fact.
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
      const after = Object.fromEntries(columns.map((column: any) => {
        if (column === 'id') return [column, id];
        const descriptor = fields[column];
        return [column, descriptor && Object.hasOwn(data, column) ? serializeField(descriptor, data[column]) : null];
      }));
      return { events, privateFact: { before: null, after } };
    },
    [`${name}.update`]: async ({ payload, principal, db, history, scope, authorization }: any) => {
      const { id, ...rest } = payload;
      if (!id) throw Object.assign(new Error('update requires an id'), { status: 400 });
      if (Object.keys(rest).length === 0) {
        if (!history) throw new ValidationError(`${name}.update requires at least one field to change`);
      }
      const currentStored = conditionalHistory ? rawRow(db, name, id) as any : null;
      if (conditionalHistory && !currentStored) throw Object.assign(new Error(`${name} ${id} not found`), { status: 404 });
      if (history) {
        if (!conditionalHistory || !history || (history.operation !== 'undo' && history.operation !== 'redo') || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.update history input is invalid`);
        const { expected, replacement } = history.input;
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
        const validRow = (row: any) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === columns.length && columns.every((column: any) => Object.hasOwn(row, column));
        if (!validRow(expected) || !validRow(replacement) || expected.id !== id || replacement.id !== id) throw new ValidationError(`${name}.update history input rows are invalid`);
        if (!columns.every((column: any) => Object.is(currentStored[column], expected[column]))) throw Object.assign(new Error(`${name}.update history expected row conflicts`), { status: 409 });
        const data: Record<string, any> = {};
        for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
          if (descriptor.kind === 'struct') {
            const cells = Object.keys(descriptor.cells).map((cell) => `${fieldName}__${cell}`);
            if (cells.some((cell) => !Object.is(currentStored[cell], replacement[cell]))) {
              data[fieldName] = Object.fromEntries(cells.map((column) => {
                const cell = column.slice(fieldName.length + 2);
                return [cell, deserializeField(descriptor.cells[cell], replacement[column])];
              }));
            }
          } else if (Object.hasOwn(replacement, fieldName) && !Object.is(currentStored[fieldName], replacement[fieldName])) {
            data[fieldName] = deserializeField(descriptor, replacement[fieldName]);
          }
        }
        // Proposed-transition admission on the history move (S5/A3): an undo/
        // redo is an update like any other, so the row grant / field access runs
        // against BOTH the current row and the proposed after-row — a history
        // move that lands the row outside the principal's write scope is denied
        // even though the current row is in scope. The history rows are the
        // durable raw-cell shapes, so they deserialize through the record's row
        // seam (the same deserialized shape the non-history path gets from
        // record.findById) before the transition gate evaluates them. The
        // invitation-acceptance bypass mirrors the non-history path: acceptance
        // updates run under the acceptance authority, not a write grant.
        const acceptanceManagedUpdate = record.name === 'Invitation'
          && admitInvitationAcceptance({
            event: { handle: verbs.updated.handle as never, data: data as unknown as Record<string, unknown> },
            principal,
          });
        if (!acceptanceManagedUpdate) {
          const before = record.deserializeRow({ ...currentStored });
          const after = record.deserializeRow({ ...replacement });
          if (!(await admitRowTransition({
            entity: record,
            verb: 'update',
            before,
            after,
            principal,
            authorization,
          }))) {
            throw Object.assign(new Error('forbidden'), { status: 403 });
          }
        }
        return { events: [{ handle: verbs.updated.handle, type: verbs.updated.type, scope: resolveGeneratedEventScope(record, { id, row: currentStored, payload: replacement, scope }), data: { ...data, id } }], privateFact: { before: expected, after: replacement } };
      }
      for (const fieldName of Object.keys(rest)) {
        if (fields[fieldName]?.kind === 'annotatedText') {
          throw new ValidationError(`${name}.${fieldName} is an annotated-text field and cannot be set through update payloads`);
        }
        if (fields[fieldName]?.immutable === true) {
          throw new ValidationError(`${name}.${fieldName} is immutable: a client may set it on create but may not change it.`);
        }
      }
      const validatedFields = validateMutation(record, rest);
      const stateTransitions = [];
      // Transition guard: for every state field in the payload, pre-read the
      // current row and verify the move is in the declared transition graph.
      // Runs after structural validation so invalid targets report as domain
      // errors before transition errors (clearer diagnostic order).
      for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
        if (descriptor.kind !== 'state') continue;
        if (!(fieldName in validatedFields)) continue;
        let current;
        try {
          // findById is installed by installEntityQueries on the record before
          // createCrudHandlers is called, so it is available at handler runtime.
          current = record.findById(id);
        } catch {
          throw Object.assign(
            new ValidationError(
              'Illegal transition check requires a durable database ' +
                `(in-memory kernel cannot verify state transitions for ${name}.${fieldName})`,
            ),
            { status: 400 },
          );
        }
        if (!current || current[fieldName] == null) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition (no current state) -> ${validatedFields[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        const currentValue = current[fieldName];
        if (currentValue === validatedFields[fieldName]) continue; // no-op, skip check
        const legalTargets = descriptor.transitions[currentValue];
        if (!legalTargets || !legalTargets.includes(validatedFields[fieldName])) {
          throw Object.assign(
            new ValidationError(
              `${name}.${fieldName}: illegal transition ${currentValue} -> ${validatedFields[fieldName]}`,
            ),
            { status: 400 },
          );
        }
        stateTransitions.push({ fieldName, from: currentValue, to: validatedFields[fieldName] });
      }
      const data: Record<string, any> = { ...validatedFields, id };
      for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
        if (descriptor.touch) data[fieldName] = new Date();
      }
      const updateRow = rawRow(db, name, id) ?? null;
      // Proposed-transition admission (S5/A3): the update's row grant / field
      // access runs against BOTH the current row and the proposed after-row, so
      // an update that moves the row out of the principal's write scope is
      // rejected even though the current row is in scope. The current row is
      // read through the record's query seam (the runtime db — a non-history
      // update runs outside the transaction, where the context db is absent),
      // exactly as the state-transition guard above does. An injected
      // authorization adapter wired into the handler context decides; with none
      // the framework row-grant engine — the default adapter's own
      // implementation — runs unchanged. An unavailable current row (in-memory
      // kernel) skips the transition check and keeps its pre-existing behavior.
      let materializedBefore;
      try {
        materializedBefore = record.findById(id);
      } catch {
        materializedBefore = null;
      }
      // Invitation-acceptance updates (useCount bump) run under the acceptance
      // authority and are admitted by the durable gate via admitInvitationAcceptance
      // — the same authority this handler's sibling remove path honors through
      // admitsInvitationRemoval. Their row grant never intended a write grant to
      // the accepting user, so the transition check must not trip on it.
      const acceptanceManagedUpdate = record.name === 'Invitation'
        && admitInvitationAcceptance({
          event: { handle: verbs.updated.handle as never, data: data as unknown as Record<string, unknown> },
          principal,
        });
      if (materializedBefore && !acceptanceManagedUpdate) {
        const proposedAfter = { ...materializedBefore, ...data };
        if (!(await admitRowTransition({
          entity: record,
          verb: 'update',
          before: materializedBefore,
          after: proposedAfter,
          principal,
          authorization,
        }))) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
      }
      const result = [{
        handle: verbs.updated.handle,
        type: verbs.updated.type,
        scope: resolveGeneratedEventScope(record, { id, row: updateRow, payload, scope }),
        data,
        ...(stateTransitions.length > 0 ? { _stateTransitions: stateTransitions } : {}),
      }];
      if (conditionalHistory) {
        const after = { ...currentStored };
        for (const [fieldName, value] of Object.entries(data)) {
          const descriptor = fields[fieldName];
          if (!descriptor || descriptor.kind === 'store') continue;
          if (descriptor.kind === 'struct') Object.assign(after, Object.fromEntries(Object.entries(flattenStruct(fieldName, descriptor, value))));
          else after[fieldName] = serializeField(descriptor, value);
        }
        for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) if (descriptor.touch) after[fieldName] = serializeField(descriptor, data[fieldName]);
        return { events: result, privateFact: { before: currentStored, after } };
      }
      return result;
    },
    [`${name}.remove`]: async ({ payload, principal, db, history, scope }: any) => {
      if (!payload.id) throw Object.assign(new Error('remove requires an id'), { status: 400 });
      if (history) {
        if (!conditionalCreateHistory || history.operation !== 'undo' || !history.input || Object.keys(history.input).length !== 2) throw new ValidationError(`${name}.remove history input is invalid`);
        if (!history.input.expected || history.input.replacement !== null || history.input.expected.id !== payload.id) throw new ValidationError(`${name}.remove history input row is invalid`);
        const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column: any) => column.name);
        const current = rawRow(db, name, payload.id);
        if (!current || Object.keys(history.input.expected).length !== columns.length || columns.some((column: any) => !Object.hasOwn(history.input.expected, column)) || !columns.every((column: any) => Object.is(current[column], history.input.expected[column]))) {
          throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
        }
        if (record.removalCascade && (await record.removalCascadeDescendants(payload.id, db)).length > 0) {
          throw Object.assign(new Error(`${name} remove conflicts: cascade descendants exist`), { status: 409 });
        }
        return { events: [{ handle: verbs.removed.handle, type: verbs.removed.type, scope: resolveGeneratedEventScope(record, { id: payload.id, row: current, payload: history.input.expected, scope }), data: { id: payload.id } }], privateFact: { before: history.input.expected, after: null } };
      }
      if (record.removalCascade) {
        return record.removalCascade(payload.id, principal, db)
          .then((rows: any) => {
            const events = rows.map(({ entity, id }: any, index: number) => ({
              ...entity.removedEvent(id, db),
              [CASCADE_PREAUTHORIZED]: true,
              ...(index < rows.length - 1 ? { [CASCADE_DESCENDANT]: true } : {}),
            }));
            if (!conditionalCreateHistory) return events;
            const parent = rows.at(-1);
            const before = rawRow(db, name, parent.id);
            return { events, privateFact: { before, after: null } };
          });
      }
      // A conditional remove reads its private preimage below, so authorize the
      // target row first rather than allowing that read to precede admission.
      const admissionRow = rawRow(db, name, payload.id);
      if (!admissionRow || (!(await admitRow({ kind: 'verb', entity: record, row: admissionRow, principal, verb: 'remove' }))
        && !(record.name === 'Invitation' && admitsInvitationRemoval(principal, payload.id)))) {
        throw Object.assign(new Error('forbidden'), { status: 403 });
      }
      const events = [{
        handle: verbs.removed.handle,
        type: verbs.removed.type,
        scope: resolveGeneratedEventScope(record, { id: payload.id, row: admissionRow, payload, scope }),
        data: { id: payload.id },
      }];
      if (!conditionalCreateHistory) return events;
      return { events, privateFact: { before: admissionRow, after: null } };
    },
  };
  const cursorPolicy: Record<string, any> = {};
  if (conditionalHistory) {
    Object.defineProperty(handlers[`${name}.update`], 'inTransaction', { value: true });
  }
  if (conditionalCreateHistory) {
    Object.defineProperty(handlers[`${name}.create`], 'inTransaction', { value: true });
  }
  Object.defineProperty(handlers[`${name}.remove`], 'inTransaction', { value: true });

  registerAnnotatedTextCrudHandlers({ record, handlers, cursorPolicy });

  for (const [fieldName, descriptor] of Object.entries(fields) as Array<[string, any]>) {
    if (descriptor.kind !== 'crdt' || descriptor.type !== 'text') continue;
    handlers[`${name}.${fieldName}.apply`] = ({ payload }: any) => {
      if (!payload || typeof payload.id !== 'string' || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'operation')) {
        throw new ValidationError(`${name}.${fieldName}.apply requires exactly { id, operation }`);
      }
      const operation = canonicalTextOp(payload.operation);
      const handle = eventHandles.native(name, fieldName, 'applied');
      return [{ handle, type: handle.type, scope: scopeOf(name, payload.id).key, data: { id: payload.id, operation } }];
    };
    cursorPolicy[`${name}.${fieldName}.apply`] = 'excluded';
  }

  // Side-table mutation handlers (map.add/setRole/remove, ordered.insert/move/
  // reorder/remove, log.append, ephemeral.set) are generated by their
  // respective strategies and merged in.
  const sideTableHandlers = Object.assign(
    {},
    ...sideTableStrategyEntries.map(({ strategy, fields: strategyFields }) =>
      strategy.mutateHandlers(name, strategyFields)),
  );

  const result = { ...handlers, ...sideTableHandlers };
  Object.defineProperty(result, CRUD_CURSOR_POLICY, {
    value: Object.freeze(cursorPolicy),
  });
  return Object.freeze(result);
}
