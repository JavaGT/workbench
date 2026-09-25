#!/usr/bin/env node
// Managed Workbench lanes keep authoring out of the canonical checkout.
// A lane is a worktree plus an explicit path claim; GitHub or an owner-authorized
// local fast-forward is the integration step, so this tool never merges silently.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FALLBACK_REPO = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_STALE_MINUTES = 90;
const DEFAULT_MAX_BEHIND = 40;
const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_TTL_HOURS = 24;
const LOCK_TIMEOUT_MS = 30_000;

class UsageError extends Error {}

export function isValidLaneName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,38}$/.test(name);
}

export function isValidOwnedPath(entry) {
  return (
    typeof entry === 'string' &&
    entry !== '' &&
    entry.trim() === entry &&
    !entry.startsWith('/') &&
    !entry.startsWith('-') &&
    !entry.split('/').includes('..') &&
    !/[*?[\]{}!]/.test(entry)
  );
}

export function pathsOverlap(a, b) {
  const left = a.replace(/\/+$/, '');
  const right = b.replace(/\/+$/, '');
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function findOverlap(ownsA, ownsB) {
  for (const a of ownsA) {
    for (const b of ownsB) {
      if (pathsOverlap(a, b)) return { a, b };
    }
  }
  return null;
}

export function staleness({
  ageSeconds,
  behind,
  worktreeMissing = false,
  branchMissing = false,
  staleMinutes = DEFAULT_STALE_MINUTES,
  maxBehind = DEFAULT_MAX_BEHIND,
}) {
  const reasons = [];
  if (worktreeMissing) reasons.push('worktree missing');
  if (branchMissing) reasons.push('branch missing');
  if (ageSeconds !== null && ageSeconds >= staleMinutes * 60) {
    reasons.push(`last commit ${Math.round(ageSeconds / 60)}min ago (stale after ${staleMinutes}min)`);
  }
  if (behind !== null && behind > maxBehind) {
    reasons.push(`behind main by ${behind} commits (drift limit ${maxBehind})`);
  }
  return { stale: reasons.length > 0, reasons };
}

function git(repo, args, cwd = repo) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function gitOptional(repo, args, cwd = repo) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function repoRoot() {
  if (process.env.WORKBENCH_REPO_ROOT) return resolve(process.env.WORKBENCH_REPO_ROOT);
  try {
    const cwd = process.cwd();
    const commonDir = resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'], cwd));
    return commonDir.endsWith('/.git') ? dirname(commonDir) : git(cwd, ['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return FALLBACK_REPO;
  }
}

function lanesRoot(repo) {
  if (process.env.WORKBENCH_LANES_ROOT) {
    return resolve(process.env.WORKBENCH_LANES_ROOT.replace(/^~(?=$|\/)/, homedir()));
  }
  return resolve(dirname(repo), 'workbench-lanes');
}

function integrationRef(repo) {
  for (const ref of ['origin/main', 'main']) {
    if (gitOptional(repo, ['rev-parse', '--verify', ref]) !== null) return ref;
  }
  throw new Error('no integration ref found; fetch origin/main or create main locally');
}

function readManifest(root) {
  const file = join(root, 'manifest.json');
  if (!existsSync(file)) return { version: 1, lanes: {} };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !value.lanes || typeof value.lanes !== 'object') {
      throw new Error('missing lanes object');
    }
    return value;
  } catch (error) {
    throw new Error(`cannot read lane manifest ${file}: ${error.message}`);
  }
}

function writeManifest(root, manifest) {
  mkdirSync(root, { recursive: true });
  const file = join(root, 'manifest.json');
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, file);
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function withManifestLock(root, fn) {
  mkdirSync(root, { recursive: true });
  const lock = join(root, '.manifest-lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = '?';
      let age = 0;
      try {
        owner = readFileSync(join(lock, 'owner'), 'utf8').trim().split(' ')[0];
        age = Math.floor(Date.now() / 1000 - statSync(lock).mtimeMs / 1000);
      } catch {}
      if (age > 120 && !processAlive(owner)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`lane manifest lock held by pid ${owner}`);
      spawnSync('sleep', ['1']);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function metadataRef(name) {
  return `refs/lanes/${name}`;
}

function writeMetadata(repo, name, metadata) {
  const blob = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
    input: `${JSON.stringify(metadata, null, 2)}\n`,
    encoding: 'utf8',
  }).trim();
  git(repo, ['update-ref', metadataRef(name), blob]);
  return blob;
}

function readMetadata(repo, name) {
  if (gitOptional(repo, ['show-ref', '--verify', '--quiet', metadataRef(name)]) === null) return null;
  try {
    return JSON.parse(git(repo, ['cat-file', '-p', metadataRef(name)]));
  } catch {
    return null;
  }
}

function metadataNames(repo) {
  const output = gitOptional(repo, ['for-each-ref', '--format=%(refname)', 'refs/lanes/']) ?? '';
  return output === '' ? [] : output.split('\n').map((ref) => ref.slice('refs/lanes/'.length));
}

function branchExists(repo, branch) {
  return gitOptional(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]) !== null;
}

function trackedPathExists(repo, ref, path) {
  return (gitOptional(repo, ['ls-tree', '-r', '--name-only', ref, '--', path]) ?? '') !== '';
}

function changedFiles(repo, lane) {
  const base = lane.base ?? integrationRef(repo);
  return git(repo, ['diff', '--name-only', `${base}..${lane.branch}`])
    .split('\n')
    .filter(Boolean);
}

function outsideOwnedFiles(lane, files) {
  return files.filter((file) => !lane.owns.some((owned) => pathsOverlap(owned, file)));
}

function installLane(worktree) {
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--silent'], {
    cwd: worktree,
    stdio: 'inherit',
    env: { ...process.env, COREPACK_ENABLE_STRICT: '0' },
  });
  if (result.status !== 0) {
    console.error(`lane: pnpm install failed in ${worktree}; run it manually before checks`);
    return false;
  }
  return true;
}

function parseCreateOptions(args) {
  const owns = [];
  let base;
  let install = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--owns') {
      const value = args[index + 1];
      if (!value) throw new UsageError('--owns requires a repo-relative path');
      owns.push(value);
      index += 1;
    } else if (arg === '--base') {
      base = args[index + 1];
      if (!base) throw new UsageError('--base requires a git ref');
      index += 1;
    } else if (arg === '--no-install') {
      install = false;
    } else {
      throw new UsageError(`unknown create option '${arg}'`);
    }
  }
  if (owns.length === 0) throw new UsageError('declare at least one --owns path');
  return { owns, base, install };
}

function cmdCreate(repo, root, name, options) {
  if (!isValidLaneName(name)) throw new UsageError(`invalid lane name '${name}'`);
  for (const owned of options.owns) {
    if (!isValidOwnedPath(owned)) {
      throw new UsageError(`owned path '${owned}' must be a literal repo-relative path, not a glob`);
    }
  }

  const worktree = join(root, name);
  const branch = `lane/${name}`;
  const startRef = options.base ?? integrationRef(repo);
  if (gitOptional(repo, ['rev-parse', '--verify', startRef]) === null) {
    throw new Error(`base ref '${startRef}' does not exist`);
  }
  if (existsSync(worktree)) throw new Error(`${worktree} already exists`);
  if (branchExists(repo, branch)) throw new Error(`branch '${branch}' already exists`);

  const entry = withManifestLock(root, () => {
    const manifest = readManifest(root);
    const active = Object.values(manifest.lanes).filter((lane) => lane.status === 'active');
    const maxActive = Number(process.env.WORKBENCH_LANES_MAX_ACTIVE ?? DEFAULT_MAX_ACTIVE);
    if (active.length >= maxActive) throw new Error(`active lane cap reached (${maxActive})`);
    for (const lane of active) {
      const overlap = findOverlap(options.owns, lane.owns);
      if (overlap) {
        throw new Error(`owned paths overlap active lane '${lane.name}': '${overlap.a}' vs '${overlap.b}'`);
      }
    }
    for (const owned of options.owns) {
      if (!trackedPathExists(repo, startRef, owned)) {
        throw new Error(`owned path '${owned}' matches no tracked files at ${startRef}`);
      }
    }

    git(repo, ['worktree', 'add', worktree, '-b', branch, startRef]);
    const ttlHours = Number(process.env.WORKBENCH_LANE_TTL_HOURS ?? DEFAULT_TTL_HOURS);
    const value = {
      name,
      branch,
      worktree,
      owns: options.owns,
      base: git(repo, ['rev-parse', startRef]),
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlHours * 3_600_000).toISOString(),
    };
    manifest.lanes[name] = value;
    writeMetadata(repo, name, value);
    writeManifest(root, manifest);
    return value;
  });

  if (options.install) installLane(worktree);
  console.log(`lane '${name}' created`);
  console.log(`  worktree: ${worktree}`);
  console.log(`  branch:   ${branch}`);
  console.log(`  owns:     ${entry.owns.join(', ')}`);
  console.log(`  expires:  ${entry.expiresAt}`);
  console.log('  next: commit milestones, then push the branch for PR/manual integration');
}

function laneFacts(repo, lane) {
  const worktreeMissing = !existsSync(lane.worktree);
  const branchMissing = !branchExists(repo, lane.branch);
  let ageSeconds = null;
  let behind = null;
  let dirtyCount = 0;
  if (!branchMissing) {
    const timestamp = Number(gitOptional(repo, ['log', '-1', '--format=%ct', lane.branch]) ?? 0);
    ageSeconds = timestamp ? Math.max(0, Math.floor(Date.now() / 1000) - timestamp) : null;
    try {
      const [left] = git(repo, ['rev-list', '--left-right', '--count', `${integrationRef(repo)}...${lane.branch}`]).split(/\s+/);
      behind = Number(left);
    } catch {
      behind = null;
    }
  }
  if (!worktreeMissing) {
    dirtyCount = git(repo, ['status', '--porcelain'], lane.worktree).split('\n').filter(Boolean).length;
  }
  return {
    worktreeMissing,
    branchMissing,
    ageSeconds,
    behind,
    dirtyCount,
    ...staleness({ ageSeconds, behind, worktreeMissing, branchMissing }),
  };
}

function cmdStatus(repo, root) {
  const manifest = readManifest(root);
  const lanes = Object.values(manifest.lanes);
  console.log(`lane root: ${root}`);
  if (lanes.length === 0) {
    console.log('no lanes registered');
    return;
  }
  console.log('lane         state     dirty  behind  idle    expires             owned');
  for (const lane of lanes) {
    const facts = lane.status === 'active' ? laneFacts(repo, lane) : null;
    const idle = facts?.ageSeconds === null || facts?.ageSeconds === undefined ? '-' : `${Math.round(facts.ageSeconds / 60)}m`;
    const behind = facts?.behind ?? '-';
    const dirty = facts?.dirtyCount ?? '-';
    const flag = facts?.stale ? '  ← STALE' : '';
    console.log(
      `${lane.name.padEnd(12)} ${lane.status.padEnd(9)} ${String(dirty).padEnd(6)} ${String(behind).padEnd(7)} ${idle.padEnd(7)} ${(lane.expiresAt ?? '-').slice(0, 19).padEnd(20)} ${lane.owns.join(', ')}${flag}`,
    );
    for (const reason of facts?.reasons ?? []) console.log(`${' '.repeat(12)}   ${reason}`);
  }
}

function parseExtendOptions(args) {
  const owns = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--owns' || !args[index + 1]) throw new UsageError('extend requires --owns <path>');
    owns.push(args[index + 1]);
    index += 1;
  }
  if (owns.length === 0) throw new UsageError('extend requires at least one --owns path');
  return owns;
}

function cmdExtend(repo, root, name, additions) {
  for (const addition of additions) {
    if (!isValidOwnedPath(addition)) throw new UsageError(`owned path '${addition}' must be a literal repo-relative path`);
  }
  const lane = withManifestLock(root, () => {
    const manifest = readManifest(root);
    const current = manifest.lanes[name];
    if (!current || current.status !== 'active') throw new Error(`active lane '${name}' not found`);
    for (const addition of additions) {
      if (!trackedPathExists(repo, current.base, addition)) {
        throw new Error(`owned path '${addition}' matches no tracked files at the lane base`);
      }
      for (const other of Object.values(manifest.lanes)) {
        if (other.name === name || other.status !== 'active') continue;
        const overlap = findOverlap([addition], other.owns);
        if (overlap) throw new Error(`extended path overlaps active lane '${other.name}': '${overlap.a}' vs '${overlap.b}'`);
      }
      if (!current.owns.includes(addition)) current.owns.push(addition);
    }
    writeMetadata(repo, name, current);
    manifest.lanes[name] = current;
    writeManifest(root, manifest);
    return current;
  });
  console.log(`lane '${name}' owns extended: ${lane.owns.join(', ')}`);
}

function cmdClose(repo, root, name, reason) {
  if (!reason) throw new UsageError('close requires --reason "one-line receipt"');
  const archived = withManifestLock(root, () => {
    const manifest = readManifest(root);
    const lane = manifest.lanes[name];
    if (!lane || lane.status !== 'active') throw new Error(`active lane '${name}' not found`);
    const branchMissing = !branchExists(repo, lane.branch);
    const worktreeMissing = !existsSync(lane.worktree);
    if (!branchMissing && !worktreeMissing) {
      const dirty = git(repo, ['status', '--porcelain'], lane.worktree);
      if (dirty) throw new Error(`lane '${name}' is dirty; commit or park its work before closing`);
    }
    if (!branchMissing) {
      const outside = outsideOwnedFiles(lane, changedFiles(repo, lane));
      if (outside.length > 0) {
        throw new Error(
          `lane '${name}' commits touch files outside its owned paths: ${outside.join(', ')}. ` +
          'Run `pnpm lanes extend ' + name + ' --owns <path>...` before closing.',
        );
      }
    }
    const head = branchMissing ? null : git(repo, ['rev-parse', lane.branch]);
    if (head) git(repo, ['update-ref', `refs/archive/lane/${name}`, head]);
    if (!worktreeMissing) git(repo, ['worktree', 'remove', lane.worktree]);
    if (!branchMissing) git(repo, ['branch', '-D', lane.branch]);
    lane.status = 'closed';
    lane.closedAt = new Date().toISOString();
    lane.closeReason = reason;
    if (head) lane.head = head;
    writeMetadata(repo, name, lane);
    manifest.lanes[name] = lane;
    writeManifest(root, manifest);
    return lane;
  });
  console.log(`lane '${name}' closed and archived at refs/archive/lane/${name}`);
  console.log(`  reason: ${reason}`);
  console.log(`  remote branch, if any, was left untouched: ${archived.branch}`);
}

function cmdReconcile(repo, root) {
  const result = withManifestLock(root, () => {
    const manifest = readManifest(root);
    let changed = false;
    for (const lane of Object.values(manifest.lanes)) {
      if (lane.status !== 'active') continue;
      if (!existsSync(lane.worktree) && !branchExists(repo, lane.branch)) {
        lane.status = 'closed';
        lane.closedAt = new Date().toISOString();
        lane.closeReason = 'reconciled: worktree and branch both missing';
        changed = true;
      }
    }
    for (const name of metadataNames(repo)) {
      const metadata = readMetadata(repo, name);
      if (!metadata || !branchExists(repo, metadata.branch)) continue;
      if (manifest.lanes[name]?.status === 'active') continue;
      manifest.lanes[name] = { ...metadata, name, status: 'active' };
      changed = true;
    }
    if (changed) writeManifest(root, manifest);
    return changed;
  });
  console.log(result ? 'lane manifest reconciled' : 'lane manifest already consistent');
}

function cmdGc(repo) {
  git(repo, ['worktree', 'prune']);
  console.log('worktree registry pruned');
}

function usage() {
  console.log(`Workbench lane workflow:
  pnpm lanes create <name> --owns <path>... [--base <ref>] [--no-install]
  pnpm lanes status
  pnpm lanes extend <name> --owns <path>...
  pnpm lanes close <name> --reason "..."
  pnpm lanes reconcile
  pnpm lanes gc

Lanes live under ~/Development/workbench-lanes by default. They own literal repo-relative
paths, refuse overlaps, enforce committed scope at close, and never merge into the canonical checkout.`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const repo = repoRoot();
  const root = lanesRoot(repo);
  if (!command || command === 'help' || command === '--help') {
    usage();
    return;
  }
  if (command === 'create') {
    const name = args.shift();
    if (!name) throw new UsageError('create requires a lane name');
    cmdCreate(repo, root, name, parseCreateOptions(args));
    return;
  }
  if (command === 'status') {
    if (args.length) throw new UsageError('status takes no arguments');
    cmdStatus(repo, root);
    return;
  }
  if (command === 'extend') {
    const name = args.shift();
    if (!name) throw new UsageError('extend requires a lane name');
    cmdExtend(repo, root, name, parseExtendOptions(args));
    return;
  }
  if (command === 'close') {
    const name = args.shift();
    if (!name) throw new UsageError('close requires a lane name');
    const reasonIndex = args.indexOf('--reason');
    if (reasonIndex < 0 || !args[reasonIndex + 1]) throw new UsageError('close requires --reason "..."');
    if (args.some((arg, index) => index !== reasonIndex && index !== reasonIndex + 1)) {
      throw new UsageError(`unknown close option '${args.find((arg, index) => index !== reasonIndex && index !== reasonIndex + 1)}'`);
    }
    cmdClose(repo, root, name, args[reasonIndex + 1]);
    return;
  }
  if (command === 'reconcile') {
    if (args.length) throw new UsageError('reconcile takes no arguments');
    cmdReconcile(repo, root);
    return;
  }
  if (command === 'gc') {
    if (args.length) throw new UsageError('gc takes no arguments');
    cmdGc(repo);
    return;
  }
  throw new UsageError(`unknown command '${command}'`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    main();
  } catch (error) {
    const usageError = error instanceof UsageError;
    console.error(`lanes: ${error.message}`);
    if (usageError) usage();
    process.exitCode = usageError ? 2 : 1;
  }
}

export { FALLBACK_REPO, lanesRoot, repoRoot, integrationRef };
