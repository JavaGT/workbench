// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it. The row itself runs through
// the field-read admission projection (S5/A3) FIRST, so a principal receives
// exactly the readable field subset; annotated-text fields that survive field
// admission are then projected through the annotated-text recipient grammar.
import { projectRowForRecipient } from './entity/projection.ts';
import { readableFieldNames } from './field-admission.ts';
import { fieldKindContribution, fieldKindSnapshotControlReason, hasFieldKindFeature } from './strategy/index.ts';
// Arms the field-kind registry when this projection module is loaded on its own.
import './annotated-text-field.ts';
import type { AuthorizationAdapter } from './authorization-adapter.ts';

export interface EntityFieldDescriptor {
  kind?: string;
  [key: string]: unknown;
}

export interface EntitySnapshotRecord {
  name?: string;
  fields: Record<string, EntityFieldDescriptor>;
  deserializeRow(row: Record<string, unknown>): Record<string, unknown>;
}

/** True when any declared field kind owns a recipient-snapshot projection. */
export function hasSnapshotProjectedFields(entity: EntitySnapshotRecord): boolean {
  return hasFieldKindFeature(entity.fields as never, 'snapshotField');
}

/** Legacy name retained for callers that still ask about annotated text specifically. */
export const hasAnnotatedTextFields = hasSnapshotProjectedFields;

/** The delivery reason declared by the kind that needs a fresh snapshot. */
export function snapshotControlReasonFor(entity: EntitySnapshotRecord): string | null {
  return fieldKindSnapshotControlReason(entity.fields as never);
}

export interface ProjectSnapshotOptions {
  db: unknown;
  entity: EntitySnapshotRecord;
  row: Record<string, unknown>;
  principal: unknown;
  authoring?: unknown;
  authorization?: AuthorizationAdapter | null;
}

export async function projectEntitySnapshot({ db, entity, row, principal, authoring = null, authorization = null }: ProjectSnapshotOptions): Promise<Record<string, unknown>> {
  const materialized = entity.deserializeRow({ ...row });
  const readable = await readableFieldNames(entity as never, materialized, principal, authorization);
  const snapshot = await projectRowForRecipient(entity as never, materialized, principal, { readable, authorization });
  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    const contribution = fieldKindContribution(descriptor.kind);
    if (contribution?.snapshotField && readable.has(fieldName)) {
      snapshot[fieldName] = await contribution.snapshotField({ db, entity: entity as never, row, principal, fieldName, descriptor: descriptor as never, authoring });
    }
  }
  return snapshot;
}
