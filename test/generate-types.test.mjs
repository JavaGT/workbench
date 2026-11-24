import { text, boolean, ref, map, scope, grant, read, write, entity, computed, generateTypes, link } from '../build/internal.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function assertTypesCompile(types) {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-generated-types-'));
  const output = join(directory, 'generated.ts');
  const config = join(directory, 'tsconfig.json');
  try {
    writeFileSync(output, types);
    writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true }, files: [output] }));
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', config], { stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('generateTypes: flat entity emits row interface and entity handle', () => {
  const Doc = entity('Doc', {
    body: text(),
    published: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write))],
  });

  const types = generateTypes([Doc]);

  assert.ok(types.includes('export interface DocRow'));
  assert.ok(types.includes('id: string'));
  assert.ok(types.includes('body: string'));
  assert.ok(types.includes('published: boolean'));
  assert.ok(types.includes('owner: string'));
  assert.ok(types.includes('export declare const Doc'));

  assert.ok(types.includes('owner(): Promise<boolean>'));
  assert.ok(types.includes('create: { (payload:'));
  assert.ok(types.includes('created:'));
  assert.ok(types.includes('update:'));
  assert.ok(types.includes('updated:'));
  assert.ok(types.includes('remove:'));
  assert.ok(types.includes('removed:'));

  assertTypesCompile(types);
});

test('generateTypes: map field emits MapFieldHandle', () => {
  const Doc = entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    collaborators: map(ref('User'), { role: ['editor', 'viewer'] }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read, write))],
  });

  const types = generateTypes([Doc]);

  assertTypesCompile(types);
  assert.ok(types.includes('MapFieldHandle'));
  assert.ok(types.includes('collaborators:'));
  assert.ok(types.includes('has(value: string)'), 'MapFieldHandle has()');
});

test('generateTypes: link field emits struct sub-cell handles', () => {
  const Doc = entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    linkShare: link({ tier: text(), token: text() }, { tiers: ['view'], tokenIntent: 'autogen' }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });

  const types = generateTypes([Doc]);

  assertTypesCompile(types);
  assert.ok(types.includes('linkShare:'), 'should type the link field');
  assert.ok(types.includes('token:'), 'should include sub-cell token');
  assert.ok(types.includes('tier:'), 'should include sub-cell tier');
});

test('generateTypes: struct row columns use the authoritative double-underscore name', () => {
  const Doc = entity('Doc', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    share: link({ tier: text(), token: text() }, { tiers: ['view'], tokenIntent: 'autogen' }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });

  const types = generateTypes([Doc]);

  assertTypesCompile(types);
  assert.ok(types.includes('share__tier: string'), types);
  assert.ok(types.includes('share__token: string'), types);
  assert.ok(!types.includes('share_tier:'), 'single underscore is not a generated column');
});

test('generateTypes: computed field (pull) excluded from row', () => {
  const Note = entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    preview: computed({ compute: ({ entity }) => entity.body?.slice(0, 10) }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });

  const types = generateTypes([Note]);

  assertTypesCompile(types);
  assert.ok(types.includes('export interface NoteRow'));
  assert.ok(types.includes('preview:'), 'pull-computed should appear on handle');
});

test('generateTypes: stored computed field included in row', () => {
  const Note = entity('Note', {
    body: text(),
    owner: ref('User', { role: 'owner' }),
    wordCount: computed.stored({ compute: ({ entity }) => entity.body?.split(' ').length }),
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });

  const types = generateTypes([Note]);
  assertTypesCompile(types);
  assert.ok(types.includes('wordCount: string'), 'stored-computed should be in row');
});

test('generateTypes: checks emit per-check methods', () => {
  const Doc = entity('Doc', {
    body: text(),
    editor: ref('User', { role: 'editor' }),
    owner: ref('User', { role: 'owner' }),
    checks: {
      isPublished: ({ entity }) => entity.body?.length > 0,
    },
    grant: () => [scope(({ is }) => is.owner()).can(() => grant(read))],
  });

  const types = generateTypes([Doc]);

  assert.ok(types.includes('owner(): Promise<boolean>'));
  assert.ok(types.includes('editor(): Promise<boolean>'));
  assert.ok(types.includes('isPublished(): Promise<boolean>'));
});

test('generateTypes: field names cannot collide with entity operations', () => {
  const types = generateTypes([{
    name: 'Collision',
    fields: {
      create: { kind: 'value', type: 'string' },
      update: { kind: 'value', type: 'string' },
      name: { kind: 'value', type: 'string' },
    },
  }]);

  assertTypesCompile(types);
  assert.ok(types.includes('fields: {'));
});
