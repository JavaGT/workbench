import { getLog } from '../log.ts';
import { serializeField, flattenStruct, resolveStrategy } from '../field-strategy.ts';
import * as eventHandle from '../event-handle.ts';
import { captureDeletedRowAnchor } from '../deleted-row-anchor.ts';
import { CASCADE_DESCENDANT } from './removal-cascade.ts';
import { applyTextOp, createTextState, restoreTextCheckpoint, textCheckpoint } from '../annotated-text.ts';
import { markAnnotatedEntityProjection } from '../annotated-text-history.ts';
import {
  annotatedTextProjectionEventTypes,
  applyAnnotatedTextNativeEvent,
  applyCanonicalAnnotatedTextOperation,
  assertAnnotatedTextNotRetired,
  cleanupAnnotatedTextProtectedTargets,
  initializeAnnotatedText,
  type AnnotatedTextFieldDescriptor,
} from '../annotated-text-projection.ts';
import type { DbHandle } from '../driver.ts';
import type { SideTableStrategyEntry, ProjectionEvent } from '../side-table-strategy.ts';
import { annotatedTextDeniedPlaceholder, readableFieldNames } from '../field-admission.ts';
import type { AuthorizationAdapter } from '../authorization-adapter.ts';
import { rawRow } from './query.ts';

export { applyCanonicalAnnotatedTextOperation };

type Row = Record<string, unknown>;
type Db = DbHandle;
type FieldDescriptor = AnnotatedTextFieldDescriptor;
type Fields = Record<string, FieldDescriptor>;

interface DataLike {
  id?: string;
  version?: number;
  __workbench?: { annotatedText?: Record<string, unknown> };
  [key: string]: unknown;
}

interface EventLike {
  handle?: eventHandle.EventIdentityHandle;
  data?: DataLike | null;
  committedAt?: unknown;
  type?: string;
  [key: string]: unknown;
  [key: symbol]: unknown;
}

type ComputedEntry = [string, { compute?: (row: Record<string, unknown>) => unknown }];

/** Quote a column identifier for generated SQL — entity fields may collide
 *  with SQLite reserved words ('order', 'group', …), which otherwise breaks
 *  the generated INSERT/UPDATE/preimage statements. */
const quoteColumn = (column: string): string => `"${column.replace(/"/g, '""')}"`;

function buildProjectedComputeRow(storedRow: Row, fields: Fields): Row {
  const row = { ...storedRow };
  for (const [fName, desc] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(row, fName)) {
      try {
        row[fName] = resolveStrategy(desc.kind).deserialize?.(row[fName], desc) ?? row[fName];
      } catch {}
    }
  }
  return row;
}

export interface RecipientRowProjectionOptions {
  authorization?: AuthorizationAdapter | null;
  // Precomputed readable field set (avoids re-running admission when the caller
  // already computed it, e.g. the snapshot call site's annotated-text loop).
  readable?: ReadonlySet<string>;
}

// The single recipient read projection (S5/A3 — field-read admission path).
// Given a materialized row, return exactly the field subset the principal can
// READ: unreadable fields are OMITTED, and an unreadable annotated-text field
// REDACTS to the explicit restricted placeholder (the existing recipient
// projection's wire shape — no canonical document facts are loaded). `id`
// always survives so the row stays addressable. This is the ONE source the
// live-delivery envelopes, the snapshot call site, and (via A2's HTTP wiring)
// the REST read path consume — a field the principal cannot read never reaches
// any recipient projection.
export async function projectRowForRecipient(
  entity: { fields?: Fields },
  row: Row | null | undefined,
  principal: unknown,
  options: RecipientRowProjectionOptions = {},
): Promise<Row> {
  if (!row || typeof row !== 'object') return (row ?? {}) as Row;
  const readable = options.readable ?? (await readableFieldNames(entity as never, row, principal, options.authorization));
  const projected: Row = {};
  if (Object.prototype.hasOwnProperty.call(row, 'id')) projected.id = row.id;
  const fields = (entity?.fields ?? {}) as Fields;
  for (const [fieldName, descriptor] of Object.entries(fields)) {
    if (readable.has(fieldName)) {
      if (Object.prototype.hasOwnProperty.call(row, fieldName)) projected[fieldName] = row[fieldName];
    } else if (descriptor?.kind === 'annotatedText') {
      projected[fieldName] = annotatedTextDeniedPlaceholder();
    }
  }
  return projected;
}

export function createEntityProjection({ name, fields, verbs, storedComputedFields, sideTableStrategyEntries, conditionalHistory = false, conditionalCreateHistory = false }: {
  name: string;
  fields: Fields;
  verbs: Record<string, { type: string }>;
  storedComputedFields: Array<ComputedEntry>;
  sideTableStrategyEntries: Array<SideTableStrategyEntry>;
  conditionalHistory?: boolean;
  conditionalCreateHistory?: boolean;
}) {
  const eventTypes = [
    verbs.created.type,
    verbs.updated.type,
    verbs.removed.type,
    ...Object.entries(fields)
      .filter(([, descriptor]) => descriptor.kind === 'crdt' && descriptor.type === 'text')
      .map(([fieldName]) => eventHandle.native(name, fieldName, 'applied').type),
    ...annotatedTextProjectionEventTypes(name, fields),
    ...sideTableStrategyEntries.flatMap(({ strategy, fields: strategyFields }) =>
      strategy.eventTypes(name, strategyFields)),
  ];

  // Annotated-text bulk materialization (esp. a large create with thousands of
  // imported ranges) would otherwise run synchronously inside the dispatch
  // transaction, freezing the event loop for the whole import. `asyncSeed`
  // selects a yielding seeding loop that periodically releases the event loop;
  // `applyAsync` is the async surface the dispatch awaits, while `apply` keeps
  // its synchronous, non-yielding behaviour for hot edits and private-fact
  // replay (no behavioural change there).
  function applyProjection(event: EventLike, db: Db, asyncSeed: boolean): void | Promise<void> {
    const table = name;
    const handle = event.handle;
    if (handle?.brand !== 'event-handle' || handle.entity !== name) return;
    for (const { strategy, fields: strategyFields } of sideTableStrategyEntries) {
      if (strategy.projectionApply({ entityName: name, fieldEntries: strategyFields, handle, event: event as unknown as ProjectionEvent, db })) return;
    }
    if (applyAnnotatedTextNativeEvent({ name, fields, handle, event, db })) return;
    if (handle.kind === eventHandle.EventKind.native && handle.nativeName === 'applied') {
      const descriptor = fields[handle.field];
      if (descriptor?.kind !== 'crdt' || descriptor.type !== 'text') return;
      const id = event.data?.id;
      if (!id) return;
      const current = db.prepare(`SELECT ${handle.field} FROM ${table} WHERE id = ?`).get(id);
      if (!current) return;
      const state = restoreTextCheckpoint(JSON.parse(current[handle.field] as string));
      const next = applyTextOp(state, event.data?.operation);
      db.prepare(`UPDATE ${table} SET ${handle.field} = ? WHERE id = ?`)
        .run(JSON.stringify(textCheckpoint(next)), id);
      getLog().debug('dispatch', `${name}.${handle.field}.applied`, { id });
      return;
    }
    if (handle.kind === eventHandle.EventKind.created) {
      assertAnnotatedTextNotRetired(db, name, fields, event.data?.id);
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(event.data ?? {})) {
        if (key === '__workbench') continue;
        const descriptor = fields[key];
        if (descriptor && descriptor.kind === 'store') continue;
        if (descriptor && descriptor.kind === 'struct') {
          Object.assign(row, flattenStruct(key, descriptor, value));
          continue;
        }
        if (descriptor) {
          row[key] = serializeField(descriptor, value);
        } else {
          row[key] = value;
        }
      }
      for (const [fieldName, descriptor] of Object.entries(fields)) {
        if (descriptor.kind === 'crdt' && descriptor.type === 'text') {
          row[fieldName] = JSON.stringify(textCheckpoint(createTextState()));
        }
      }
      for (const [fieldName, { compute }] of storedComputedFields) {
        try {
          const computeRow = buildProjectedComputeRow(row, fields);
          const result = compute!(computeRow);
          row[fieldName] = resolveStrategy('computed').serialize!(result);
        } catch {
          throw new Error(`${name}.${fieldName} computed.stored compute failed`);
        }
      }
      const cols = Object.keys(row);
      if (cols.length > 0) {
        db.prepare(
          `INSERT INTO ${table} (${cols.map(quoteColumn).join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`,
        ).run(row);
        const init = initializeAnnotatedText({ name, fields, event, db, row, asyncSeed });
        if (init instanceof Promise) return init;
        getLog().debug('dispatch', `${name}.created`, { id: row.id ?? event.data?.id });
      }
    } else if (handle.kind === eventHandle.EventKind.updated) {
      if (conditionalHistory) return;
      const { id, ...data } = (event.data ?? {}) as DataLike;
      if (!id) return;
      const updates = [];
      const params: Record<string, unknown> = { id };
      for (const [key, value] of Object.entries(data)) {
        const descriptor = fields[key];
        if (descriptor && descriptor.kind === 'store') continue;
        if (descriptor && descriptor.kind === 'struct') {
          for (const [column, cell] of Object.entries(flattenStruct(key, descriptor, value))) {
            updates.push(`${quoteColumn(column)} = :${column}`);
            params[column] = cell;
          }
          continue;
        }
        const stored = descriptor ? serializeField(descriptor, value) : value;
        updates.push(`${quoteColumn(key)} = :${key}`);
        params[key] = stored;
      }
      if (storedComputedFields.length > 0) {
        const existing = db.prepare(`SELECT * FROM ${table} WHERE id = :id`).get({ id });
        if (existing) {
          const merged = { ...existing };
          for (const [key] of Object.entries(data)) {
            if (Object.prototype.hasOwnProperty.call(fields, key)) {
              merged[key] = Object.prototype.hasOwnProperty.call(params, key) ? params[key] : data[key];
            }
          }
          for (const [fieldName, { compute }] of storedComputedFields) {
            try {
              const computeRow = buildProjectedComputeRow(merged, fields);
              const result = compute!(computeRow);
              const stored = resolveStrategy('computed').serialize!(result);
              updates.push(`${quoteColumn(fieldName)} = :${fieldName}`);
              params[fieldName] = stored;
            } catch {
              throw new Error(`${name}.${fieldName} computed.stored compute failed`);
            }
          }
        }
      }
      if (updates.length > 0) {
        db.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = :id`).run(params);
        getLog().debug('dispatch', `${name}.updated`, { id: params.id });
      }
    } else if (handle.kind === eventHandle.EventKind.removed) {
      // A cascade root with conditional-create history deletes from its exact
      // private fact. Its descendants have no private facts in that receipt.
      if (conditionalCreateHistory && !event[CASCADE_DESCENDANT]) return;
      const id = event.data?.id;
      // Capture the deleted-row history anchor BEFORE the delete, in the
      // same projection-consumer call (same transaction as the DELETE) —
      // atomic, so a committed removal can never leave the anchor missing.
      const existingRow = id ? rawRow(db, table, id) : undefined;
      if (existingRow) captureDeletedRowAnchor(db as Parameters<typeof captureDeletedRowAnchor>[0], name, id as string, existingRow, event.committedAt as string);
      cleanupAnnotatedTextProtectedTargets(db, name, fields, id);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      getLog().debug('dispatch', `${name}.removed`, { id });
    }
  }

  const projection = {
    eventTypes,
    apply: (event: EventLike, db: Db): void => { applyProjection(event, db, false); },
    applyAsync: async (event: EventLike, db: Db): Promise<void> => { await applyProjection(event, db, true); },
  };
  if (Object.values(fields).some((field) => field.kind === 'annotatedText')) markAnnotatedEntityProjection(projection);
  return Object.freeze(projection);
}

export function createConditionalHistoryProjection({ name, verbs }: { name: string; verbs: Record<string, { type: string }> }) {
  return Object.freeze({
    actionType: `${name}.update`,
    eventTypes: [verbs.updated.type],
    privateFact: true,
    replay: false,
    apply: (event: EventLike, db: Db, { privateFact }: { privateFact?: { before?: Row; after?: Row } }) => {
      const before = privateFact?.before;
      const after = privateFact?.after;
      if (!before || !after || before.id !== after.id || event.data?.id !== before.id) throw new Error(`${name}.update private fact is invalid`);
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name as string);
      if (columns.some((column) => !Object.hasOwn(before, column) || !Object.hasOwn(after, column))) throw new Error(`${name}.update private fact is incomplete`);
      const current = rawRow(db, name, before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      const params: Record<string, unknown> = {};
      const assignments = columns.filter((column) => column !== 'id').map((column) => {
        params[`after_${column}`] = after[column];
        return `${quoteColumn(column)} = :after_${column}`;
      });
      const preimage = columns.map((column) => {
        params[`before_${column}`] = before[column];
        return `${quoteColumn(column)} IS :before_${column}`;
      });
      const result = db.prepare(`UPDATE ${name} SET ${assignments.join(', ')} WHERE ${preimage.join(' AND ')}`).run(params);
      if (Number(result.changes) !== 1) {
        if (!db.prepare(`SELECT 1 FROM ${name} WHERE id = ?`).get(before.id)) {
          throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
        }
        throw Object.assign(new Error(`${name} update conflicts`), { status: 409 });
      }
    },
  });
}

export function createConditionalCreateHistoryProjection({ name, verbs }: { name: string; verbs: Record<string, { type: string }> }) {
  const apply = (event: EventLike, db: Db, { privateFact }: { privateFact?: { before?: Row | null; after?: Row | null } }) => {
    const { before, after } = privateFact ?? {};
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name as string);
    if (event.type === verbs.created.type) {
      if (before !== null || !after || after.id !== event.data?.id) throw new Error(`${name}.create private fact is invalid`);
      const current = rawRow(db, name, after.id);
      if (!current) throw Object.assign(new Error(`${name}.create projection conflicts`), { status: 409 });
      if (Object.keys(after).length !== columns.length || columns.some((column) => !Object.hasOwn(after, column)) || !columns.every((column) => Object.is(current[column], after[column]))) {
        throw Object.assign(new Error(`${name}.create projection conflicts`), { status: 409 });
      }
    } else {
      if (!before || after !== null || before.id !== event.data?.id || Object.keys(before).length !== columns.length || columns.some((column) => !Object.hasOwn(before, column))) throw new Error(`${name}.remove private fact is invalid`);
      const current = rawRow(db, name, before.id);
      if (!current) throw Object.assign(new Error(`${name} ${before.id} not found`), { status: 404 });
      if (!columns.every((column) => Object.is(current[column], before[column]))) throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
      captureDeletedRowAnchor(db as Parameters<typeof captureDeletedRowAnchor>[0], name, before.id as string, current, event.committedAt as string);
      const predicates = columns.map((column) => `${quoteColumn(column)} IS :${column}`);
      const result = db.prepare(`DELETE FROM ${name} WHERE ${predicates.join(' AND ')}`).run(before);
      if (Number(result.changes) !== 1) throw Object.assign(new Error(`${name} remove conflicts`), { status: 409 });
    }
  };
  return Object.freeze([Object.freeze({
    actionType: `${name}.create`,
    eventTypes: [verbs.created.type],
    privateFact: true,
    replay: false,
    apply,
  }), Object.freeze({
    actionType: `${name}.remove`,
    eventTypes: [verbs.removed.type],
    privateFact: true,
    replay: false,
    apply,
  })]);
}
