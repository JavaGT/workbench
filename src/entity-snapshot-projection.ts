// Recipient snapshots replace annotated-text storage with the package-owned
// projection before a transport can serialize it. The row itself runs through
// the field-read admission projection (S5/A3) FIRST, so a principal receives
// exactly the readable field subset; annotated-text fields that survive field
// admission are then projected through the annotated-text recipient grammar.
import { projectRowForRecipient } from './entity/projection.ts';
import { readableFieldNames } from './field-admission.ts';
import { fieldKindContribution, hasFieldKindFeature } from './strategy/index.ts';
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

export function hasAnnotatedTextFields(entity: EntitySnapshotRecord): boolean {
  return hasFieldKindFeature(entity.fields as never, 'snapshotField');
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
