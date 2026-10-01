import { closeSync, globSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_FAILURE_CHARS = 12_000;
const MAX_FAILURE_LINES = 80;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const keepLog = process.env.WORKBENCH_KEEP_TEST_LOGS === '1';

function configuredMilliseconds(name, fallback) {
	const value = process.env[name];
	if (value === undefined) return fallback;
	const milliseconds = Number(value);
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
		throw new Error(`${name} must be a positive number of milliseconds`);
	}
	return milliseconds;
}

let deadlineMs;
let killGraceMs;
try {
	deadlineMs = configuredMilliseconds('WORKBENCH_TEST_DEADLINE_MS', DEFAULT_DEADLINE_MS);
	killGraceMs = configuredMilliseconds('WORKBENCH_TEST_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS);
} catch (error) {
	console.error(error.message);
	process.exit(2);
}

const logDirectory = mkdtempSync(join(tmpdir(), 'workbench-test-'));
const logPath = join(logDirectory, 'node-test.log');
const output = openSync(logPath, 'w');
const started = performance.now();
const testFiles = [...globSync('test/**/*.test.mjs'), ...globSync('scripts/**/*.test.mjs')].filter((file) => !file.startsWith('test/browser/'));

function stop(child, signal) {
	if (child.pid === undefined) return;
	if (process.platform === 'win32') {
		const args = ['/pid', String(child.pid), '/t'];
		if (signal === 'SIGKILL') args.push('/f');
		const taskkill = spawn('taskkill.exe', args, { stdio: 'ignore', windowsHide: true });
		taskkill.once('error', () => child.kill(signal));
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

let activeChild = null;
let shutdownSignal = null;
let shutdownTimer;

function requestShutdown(signal) {
	if (shutdownSignal) return;
	shutdownSignal = signal;
	if (!activeChild) {
		process.exit(signal === 'SIGINT' ? 130 : 128 + (signal === 'SIGHUP' ? 1 : 15));
		return;
	}
	stop(activeChild, 'SIGTERM');
	shutdownTimer = setTimeout(() => {
		if (activeChild) stop(activeChild, 'SIGKILL');
	}, killGraceMs);
	shutdownTimer.unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => requestShutdown(signal));
}

process.on('exit', () => {
	if (activeChild) stop(activeChild, 'SIGKILL');
});

const child = spawn(
	process.execPath,
	['--test', '--test-force-exit', ...(process.argv.slice(2).some((arg) => arg.startsWith('--test-reporter')) ? [] : ['--test-reporter=dot']), '--test-timeout=30000', ...process.argv.slice(2), ...testFiles],
	{ cwd: process.cwd(), env: process.env, stdio: ['ignore', output, output], detached: process.platform !== 'win32' },
);
activeChild = child;

const result = await new Promise((resolve) => {
	let settled = false;
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		stop(child, 'SIGTERM');
		setTimeout(() => {
			if (activeChild) stop(activeChild, 'SIGKILL');
		}, killGraceMs).unref?.();
	}, deadlineMs);
	const finish = (value) => {
		if (settled) return;
		settled = true;
		clearTimeout(deadline);
		if (shutdownTimer) clearTimeout(shutdownTimer);
		activeChild = null;
		resolve({ ...value, timedOut });
	};
	child.once('error', (error) => finish({ error }));
	child.once('close', (code, signal) => finish({ code: timedOut ? 124 : code, signal }));
});
closeSync(output);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (result.code === 0 && !result.error && !result.timedOut) {
  console.log(`PASS node --test (${seconds}s)`);
  if (keepLog) {
    console.log(`Full log: ${logPath}`);
  } else {
    rmSync(logDirectory, { recursive: true, force: true });
  }
  process.exitCode = 0;
} else {
	console.error(`FAIL node --test (${seconds}s${result.signal ? `, signal ${result.signal}` : ''})`);
	if (result.timedOut) console.error(`Command exceeded its ${deadlineMs}ms deadline; sent SIGTERM, then SIGKILL after ${killGraceMs}ms if needed.`);
	if (result.error) console.error(result.error.message);

  const log = readFileSync(logPath, 'utf8');
  const failureStart = log.search(/failed tests:/i);
  const relevant = failureStart === -1 ? log : log.slice(failureStart);
  const excerpt = relevant.split('\n').slice(0, MAX_FAILURE_LINES).join('\n').slice(0, MAX_FAILURE_CHARS);
  if (excerpt) console.error(excerpt);
  if (excerpt.length < relevant.length) console.error('... failure output truncated; inspect the full log for all failures.');
  console.error(`Full log: ${logPath}`);

	if (shutdownSignal) {
		process.exitCode = shutdownSignal === 'SIGINT' ? 130 : 128 + (shutdownSignal === 'SIGHUP' ? 1 : 15);
	} else if (result.signal) {
		process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
}
