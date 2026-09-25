import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findOverlap,
  isValidLaneName,
  isValidOwnedPath,
  pathsOverlap,
  staleness,
} from '../scripts/lane.mjs';

const SCRIPT = resolve(fileURLToPath(new URL('../scripts/lane.mjs', import.meta.url)));

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function run(repo, args, laneRoot = join(repo, 'lanes')) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      WORKBENCH_REPO_ROOT: repo,
      WORKBENCH_LANES_ROOT: laneRoot,
      WORKBENCH_LANES_MAX_ACTIVE: '4',
      WORKBENCH_LANE_TTL_HOURS: '2',
    },
  });
}

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-lanes-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'lane-test@example.test']);
  git(repo, ['config', 'user.name', 'Lane Test']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'src', 'one.txt'), 'one\n');
  writeFileSync(join(repo, 'docs', 'two.md'), 'two\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  return { repo, laneRoot: join(parent, 'workbench-lanes') };
}

test('lane names and owned paths reject ambiguous input', () => {
  assert.equal(isValidLaneName('docs-refresh'), true);
  assert.equal(isValidLaneName('../escape'), false);
  assert.equal(isValidOwnedPath('src/entity'), true);
  assert.equal(isValidOwnedPath('src/**'), false);
  assert.equal(isValidOwnedPath('/tmp/entity'), false);
  assert.equal(pathsOverlap('src', 'src/entity/query.ts'), true);
  assert.deepEqual(findOverlap(['src'], ['src/entity']), { a: 'src', b: 'src/entity' });
});

test('staleness reports missing trees, age, and drift', () => {
  assert.deepEqual(staleness({ ageSeconds: 60, behind: 0 }), { stale: false, reasons: [] });
  const result = staleness({ ageSeconds: 5400, behind: 41, worktreeMissing: true, branchMissing: true });
  assert.equal(result.stale, true);
  assert.equal(result.reasons.length, 4);
});

test('create, status, overlap refusal, and close preserve a lane receipt', (t) => {
  const { repo, laneRoot } = fixture(t);
  const created = run(repo, ['create', 'docs-refresh', '--owns', 'src', '--no-install'], laneRoot);
  assert.match(created, /lane 'docs-refresh' created/);
  assert.equal(existsSync(join(laneRoot, 'docs-refresh', 'src', 'one.txt')), true);

  const status = run(repo, ['status'], laneRoot);
  assert.match(status, /docs-refresh\s+active/);

  assert.throws(
    () => run(repo, ['create', 'overlap', '--owns', 'src/entity', '--no-install'], laneRoot),
    /owned paths overlap active lane/,
  );

  const closed = run(repo, ['close', 'docs-refresh', '--reason', 'fixture lane complete'], laneRoot);
  assert.match(closed, /closed and archived at refs\/archive\/lane\/docs-refresh/);
  assert.equal(existsSync(join(laneRoot, 'docs-refresh')), false);
  assert.equal(git(repo, ['rev-parse', 'refs/archive/lane/docs-refresh']), git(repo, ['rev-parse', 'HEAD']));
  assert.match(run(repo, ['status'], laneRoot), /docs-refresh\s+closed/);
});

test('status resolves the main lane root when invoked inside a linked lane', (t) => {
  const { repo, laneRoot } = fixture(t);
  run(repo, ['create', 'root-check', '--owns', 'src', '--no-install'], laneRoot);
  const linkedLane = join(laneRoot, 'root-check');
  const env = { ...process.env };
  delete env.WORKBENCH_REPO_ROOT;
  delete env.WORKBENCH_LANES_ROOT;
  const output = execFileSync(process.execPath, [SCRIPT, 'status'], {
    cwd: linkedLane,
    encoding: 'utf8',
    env,
  });
  assert.match(output, /lane root: .*workbench-lanes/);
  assert.match(output, /root-check\s+active/);
});
