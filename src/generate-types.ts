import { structCellColumn } from './field-strategy.ts';

interface Descriptor {
  kind: string;
  type?: string;
  mode?: string;
  cells?: Readonly<Record<string, unknown>>;
  role?: string | readonly string[];
}

interface GeneratedEntity {
  name: string;
  fields?: Readonly<Record<string, Descriptor>>;
  registry?: Readonly<Record<string, { run?: unknown }>>;
}

function descriptorTsType(descriptor: Descriptor | undefined): string | null {
  if (!descriptor) return 'unknown';

  const { kind, type } = descriptor;

  if (kind === 'value' || kind === 'crdt' || kind === 'projected' || (kind === 'computed' && descriptor.mode === 'stored')) {
    switch (type) {
      case 'boolean': return 'boolean';
      case 'number': return 'number';
      default: return 'string';
    }
  }

  if (kind === 'hash') return 'string';
  if (kind === 'state') return 'string';
  if (kind === 'struct') return 'Record<string, string>';
  if (kind === 'store' && type === 'map') return 'MapFieldHandle';
  if (kind === 'store' && type === 'log') return 'LogFieldHandle';
  if (kind === 'ordered') return 'OrderedFieldHandle';
  if (kind === 'computed' && descriptor.mode === 'pull') return null;

  return 'unknown';
}

function isStoredColumn(descriptor: Descriptor | undefined): boolean {
  if (!descriptor) return false;
  const { kind } = descriptor;
  if (kind === 'computed' && descriptor.mode === 'pull') return false;
  if (['value', 'crdt', 'hash', 'state', 'projected'].includes(kind)) return true;
  if (kind === 'computed' && descriptor.mode === 'stored') return true;
  return false;
}

function rowProperties(fields: Readonly<Record<string, Descriptor>>): string[] {
  const lines = ['id: string'];
  for (const [name, desc] of Object.entries(fields)) {
    if (desc.kind === 'struct') {
      for (const [cellName] of Object.entries(desc.cells || {})) {
        lines.push(`${structCellColumn(name, cellName)}: string`);
      }
      continue;
    }
    if (!isStoredColumn(desc)) continue;
    lines.push(`${name}: ${descriptorTsType(desc)}`);
  }
  return lines;
}

function entityHandleType(_name: string, fields: Readonly<Record<string, Descriptor>>): string[] {
  const lines = [];

  for (const [fname, desc] of Object.entries(fields)) {
    if (desc.kind === 'struct') {
      const subs = [];
      for (const [cellName] of Object.entries(desc.cells || {})) {
        subs.push(`  ${cellName}: { is(v: string): boolean; in(vs: string[]): boolean; isNull(): boolean; gte(v: string): boolean; lte(v: string): boolean }`);
      }
      lines.push(`  ${fname}: {\n${subs.join('\n')}\n  }`);
      continue;
    }

    if (desc.kind === 'store' && desc.type === 'map') {
      lines.push(`  ${fname}: MapFieldHandle`);
      continue;
    }

    if (desc.kind === 'store' && desc.type === 'log') {
      lines.push(`  ${fname}: LogFieldHandle`);
      continue;
    }

    if (desc.kind === 'ordered') {
      lines.push(`  ${fname}: OrderedFieldHandle`);
      continue;
    }

    if (desc.kind === 'computed' && desc.mode === 'pull') {
      lines.push(`  ${fname}: { readonly fieldName: '${fname}' }`);
      continue;
    }

    if (desc.kind === 'computed' && desc.mode === 'stored') {
      lines.push(`  ${fname}: { readonly fieldName: '${fname}'; is(v: ${descriptorTsType(desc)}): boolean; in(vs: ${descriptorTsType(desc)}[]): boolean; isNull(): boolean }`);
      continue;
    }

    if (desc.kind === 'value' || desc.kind === 'crdt' || desc.kind === 'hash' || desc.kind === 'state' || desc.kind === 'projected') {
      const t = descriptorTsType(desc);
      const extra = desc.type === 'ref' && !desc.role ? ` | { id: string }` : '';
      lines.push(`  ${fname}: { readonly fieldName: '${fname}'; is(v: ${t}${extra}): boolean; in(vs: ${t}[]): boolean; isNull(): boolean${desc.type !== 'ref' && desc.type !== 'hash' ? `; gte(v: ${t}): boolean; lte(v: ${t}): boolean` : ''} }`);
    }
  }

  return lines;
}

export function generateTypes(entities: readonly GeneratedEntity[]): string {
  const parts = [];

  parts.push(`// Generated type definitions for workbench declarations.`);
  parts.push(`// Do not edit manually.`);
  parts.push(``);
  parts.push(`export type PrincipalType = "user" | "link" | "system" | "anonymous";`);
  parts.push(``);
  parts.push(`export interface Principal {`);
  parts.push(`  readonly type: PrincipalType;`);
  parts.push(`  readonly id: string | null;`);
  parts.push(`  readonly attributes: Readonly<Record<string, unknown>>;`);
  parts.push(`}`);
  parts.push(``);
  parts.push(`export interface MapFieldHandle {`);
  parts.push(`  has(value: string): boolean;`);
  parts.push(`  get(value: string): { member_id: string; role: string } | undefined;`);
  parts.push(`}`);
  parts.push(``);
  parts.push(`export interface LogFieldHandle {`);
  parts.push(`  append(entry: Record<string, unknown>): void;`);
  parts.push(`}`);
  parts.push(``);
  parts.push(`export interface OrderedFieldHandle {`);
  parts.push(`  insertAt(index: number, value: unknown): void;`);
  parts.push(`  remove(id: string): void;`);
  parts.push(`  toArray(): Array<{ id: string; value: unknown }>;`);
  parts.push(`}`);
  parts.push(``);

  for (const entity of entities) {
    const name = entity.name;
    const fields = entity.fields || {};
    const registry = entity.registry || {};

    parts.push(`export interface ${name}Row {`);
    for (const line of rowProperties(fields)) {
      parts.push(`  ${line};`);
    }
    parts.push(`}`);
    parts.push(``);

    const checkNames = Object.keys(registry).filter((k) => registry[k]?.run);
    parts.push(`export interface ${name}Checks {`);
    for (const checkName of checkNames) {
      parts.push(`  ${checkName}(): Promise<boolean>;`);
    }
    parts.push(`}`);
    parts.push(``);

    parts.push(`export declare const ${name}: {`);
    parts.push(`  readonly name: '${name}';`);
    parts.push(`  create: { (payload: Partial<${name}Row>): ${name}Row; payload: ${name}Row };`);
    parts.push(`  created: { data: Partial<${name}Row> };`);
    parts.push(`  update: { id: string; payload: Partial<${name}Row> };`);
    parts.push(`  updated: { id: string; data: Partial<${name}Row> };`);
    parts.push(`  remove: { id: string };`);
    parts.push(`  removed: { id: string };`);

    parts.push(`  fields: {`);
    for (const line of entityHandleType(name, fields)) {
      parts.push(`  ${line};`);
    }
    parts.push(`  };`);

    parts.push(`}`);
    parts.push(``);
  }

  return parts.join('\n') + '\n';
}
