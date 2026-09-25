// Repeatable performance harness for the workbench compile, commit, and deliver loops.
//
// The HTTP workload exercises the real node:http transport with both default-on
// authorization layers engaged. The other workloads measure the durable kernel,
// live delivery, schema preparation, and annotated-text fold paths directly.
// It has no package dependencies beyond the Node runtime.
//
// Normal output is exactly one stable JSON object on stdout. Progress and
// diagnostics go to stderr, so a report can be captured directly:
//
//   node bench/hot-path.mjs > /tmp/workbench-benchmark.json
//
// See docs/performance-benchmarks.md for the workload definitions and compare
// workflow.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import inspector from 'node:inspector';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import workbench, { entity } from '../build/internal.mjs';
import {
  text, number, boolean, ref, scope, grant, read, write, subscribe, everyone, principal,
  annotatedText, annotation, annotationAction,
} from '../build/index.mjs';
import { createServer, durableMutationVariant } from '../build/pipeline.mjs';
import { executeDDL, executeFrameworkDDL } from '../build/ddl.mjs';
import { createLiveDeliveryCore } from '../build/live-delivery-core.mjs';
import {
  applyTextOperation,
  importTextToFamily,
  materializeText,
  restoreTextFamily,
  textFamilyCheckpoint,
} from '../build/annotated-text-continuous.mjs';
import { projectAnnotatedTextSnapshot } from '../build/annotated-text-snapshot.mjs';
import { ensureStream, ensureLease, hashClientNonce } from '../build/annotated-text-authoring-stream.mjs';
import { readAnnotatedTextFamilyCheckpoint, restoreTextFamilySerialized } from '../build/annotated-text-authoring-public.mjs';
import { materializeAnnotatedTextSnapshot } from '../public/workbench-client.mjs';

const SCHEMA_VERSION = 2;
const BENCHMARK_NAME = 'workbench-performance';
const DEFAULT_SAMPLES = 5;
const DEFAULT_MAX_REGRESSION_PCT = 10;
const DEFAULT_PROFILE_PATH = 'bench/workbench-performance.cpuprofile';
const DEFAULT_RECORD_PATH = 'docs/performance-results.md';
const BENCHMARK_NAMES = Object.freeze([
  'compile',
  'http-crud',
  'commit',
  'live-delivery',
  'annotated-text',
  'annotated-text-unified',
]);

// The three sizes keep the request shape constant while increasing the amount
// of live database state. A fresh app is used for each sample, so setup and
// teardown do not contaminate the timed HTTP phases.
const WORKLOADS = Object.freeze({
  small: Object.freeze({
    warmup: 50,
    create: 200,
    read: 200,
    list: 50,
    update: 200,
    listSeed: 25,
  }),
  medium: Object.freeze({
    warmup: 100,
    create: 600,
    read: 600,
    list: 120,
    update: 600,
    listSeed: 60,
  }),
  large: Object.freeze({
    warmup: 200,
    create: 1200,
    read: 1200,
    list: 240,
    update: 1200,
    listSeed: 120,
  }),
});

// These workloads cover the durable kernel, delivery loop, and the largest
// known client/server data structure. Counts are deliberately small enough for
// a quick local run while still exposing growth with state and history size.
const COMMIT_WORKLOADS = Object.freeze({
  small: Object.freeze({ warmup: 100, dispatch: 500, dedupe: 200, batch: 100, batchSize: 4 }),
  medium: Object.freeze({ warmup: 300, dispatch: 1500, dedupe: 600, batch: 300, batchSize: 8 }),
  large: Object.freeze({ warmup: 600, dispatch: 4000, dedupe: 1500, batch: 600, batchSize: 16 }),
});

const COMPILE_WORKLOADS = Object.freeze({
  small: Object.freeze({ apps: 5, entities: 1, fields: 6 }),
  medium: Object.freeze({ apps: 3, entities: 4, fields: 10 }),
  large: Object.freeze({ apps: 1, entities: 10, fields: 14 }),
});

const LIVE_WORKLOADS = Object.freeze({
  small: Object.freeze({ history: 25, subscribers: 1, fanout: 100 }),
  medium: Object.freeze({ history: 100, subscribers: 10, fanout: 250 }),
  large: Object.freeze({ history: 400, subscribers: 40, fanout: 500 }),
});

const TEXT_WORKLOADS = Object.freeze({
  small: Object.freeze({ lines: 16, textChars: textWorkloadText(16).length, operations: 16 }),
  medium: Object.freeze({ lines: 96, textChars: textWorkloadText(96).length, operations: 32 }),
  large: Object.freeze({ lines: 256, textChars: textWorkloadText(256).length, operations: 64 }),
});

// Transcript-shaped unified annotation workloads: one annotatedText declaration
// with timing + confidence + comment families and declaration-owned actions,
// imported as ordinary source ranges, snapshotted eagerly, serialized, and
// materialized by the client. `annotations` counts ranges per document;
// `corrects` counts declaration-action dispatches against the same authoring
// position frame.
const UNIFIED_WORKLOADS = Object.freeze({
  small: Object.freeze({ apps: 5, annotations: 50, corrects: 10 }),
  medium: Object.freeze({ apps: 3, annotations: 500, corrects: 30 }),
  large: Object.freeze({ apps: 1, annotations: 2000, corrects: 60 }),
});

const DEFAULT_SIZES = Object.freeze(Object.keys(WORKLOADS));
const DEFAULT_BENCHMARKS = Object.freeze([...BENCHMARK_NAMES]);
const me = principal({ type: 'user', id: 'bench-user' });

function log(message) {
  process.stderr.write(`${message}\n`);
}

function usage() {
  return `Usage: node bench/hot-path.mjs [options]

Options:
  --benchmarks <names>         Comma-separated families: ${BENCHMARK_NAMES.join(',')}
                               (default: all families)
  --sizes <names>             Comma-separated sizes: small,medium,large
                              (default: all three)
  --samples <count>           Samples per size (default: ${DEFAULT_SAMPLES})
  --compare <file>            Compare current medians with a JSON report
  --max-regression-pct <pct>  Allowed median slowdown per metric (default: ${DEFAULT_MAX_REGRESSION_PCT})
  --profile [file]             Write a V8 CPU profile (default: ${DEFAULT_PROFILE_PATH})
  --record [file]              Write Markdown results (default: ${DEFAULT_RECORD_PATH})
  --no-record                   Do not write the Markdown results file
  --help                      Show this help

Output is one JSON object on stdout; progress is written to stderr.`;
}

function optionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined && inlineValue !== '') return { value: inlineValue, index };
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return { value: next, index: index + 1 };
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function percentage(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    benchmarks: [...DEFAULT_BENCHMARKS],
    sizes: [...DEFAULT_SIZES],
    samples: DEFAULT_SAMPLES,
    comparePath: null,
    maxRegressionPct: DEFAULT_MAX_REGRESSION_PCT,
    profilePath: null,
    recordPath: DEFAULT_RECORD_PATH,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    if (name === '--sizes') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      const sizes = selected.value.split(',').map((value) => value.trim()).filter(Boolean);
      if (sizes.length === 0) throw new Error('--sizes must name at least one workload');
      for (const size of sizes) {
        if (!Object.hasOwn(WORKLOADS, size)) {
          throw new Error(`unknown workload '${size}' (choose ${DEFAULT_SIZES.join(', ')})`);
        }
      }
      if (new Set(sizes).size !== sizes.length) throw new Error('--sizes cannot contain duplicates');
      options.sizes = sizes;
      continue;
    }
    if (name === '--benchmarks') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      const benchmarks = selected.value.split(',').map((value) => value.trim()).filter(Boolean);
      if (benchmarks.length === 0) throw new Error('--benchmarks must name at least one family');
      for (const benchmark of benchmarks) {
        if (!BENCHMARK_NAMES.includes(benchmark)) {
          throw new Error(`unknown benchmark '${benchmark}' (choose ${BENCHMARK_NAMES.join(', ')})`);
        }
      }
      if (new Set(benchmarks).size !== benchmarks.length) {
        throw new Error('--benchmarks cannot contain duplicates');
      }
      options.benchmarks = benchmarks;
      continue;
    }
    if (name === '--samples') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.samples = positiveInteger(selected.value, name);
      if (options.samples > 100) throw new Error('--samples must be at most 100');
      continue;
    }
    if (name === '--compare') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.comparePath = selected.value;
      continue;
    }
    if (name === '--max-regression-pct') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.maxRegressionPct = percentage(selected.value, name);
      continue;
    }
    if (name === '--profile') {
      if (inlineValue !== undefined && inlineValue !== '') {
        options.profilePath = inlineValue;
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          options.profilePath = next;
          index += 1;
        } else {
          options.profilePath = DEFAULT_PROFILE_PATH;
        }
      }
      continue;
    }
    if (name === '--record') {
      const selected = optionValue(argv, index, name, inlineValue);
      index = selected.index;
      options.recordPath = selected.value;
      continue;
    }
    if (name === '--no-record') {
      if (inlineValue !== undefined) throw new Error('--no-record does not take a value');
      options.recordPath = null;
      continue;
    }
    throw new Error(`unknown option '${argument}'`);
  }

  return options;
}

function ownedNote() {
  return entity('Note', {
    title: text(),
    body: text(),
    count: number(),
    done: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

function ownedFeed() {
  return entity('Feed', {
    title: text(),
    body: text(),
    count: number(),
    done: boolean(),
    owner: ref('User', { role: 'owner', readonly: true }),
    grant: () => [
      scope(({ is }) => is.owner()).can(async ({ is }) =>
        (await is.owner()) ? grant(read, write, subscribe) : grant(read)),
    ],
  });
}

async function request(origin, path, { method = 'GET', body, expect } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${origin}${path}`, init);
  } catch (error) {
    throw new Error(`request ${method} ${path} threw: ${error?.message ?? error}`);
  }

  if (expect !== undefined && response.status !== expect) {
    let detail = '';
    try { detail = await response.text(); } catch { /* best-effort error detail */ }
    throw new Error(
      `${method} ${path} expected ${expect} got ${response.status}`
      + (detail ? `: ${detail.slice(0, 200)}` : ''),
    );
  }
  return response;
}

async function createPass(origin, count, ids) {
  for (let index = 0; index < count; index += 1) {
    const response = await request(origin, '/notes', {
      method: 'POST',
      body: { title: `t${index}`, body: `b${index}`, count: index, done: index % 2 === 0 },
      expect: 201,
    });
    const row = await response.json();
    if (!row || row.id == null) throw new Error('create returned no id');
    ids.push(row.id);
  }
}

async function readPass(origin, count, ids) {
  for (let index = 0; index < count; index += 1) {
    const id = ids[index % ids.length];
    const response = await request(origin, `/notes/${id}`, { expect: 200 });
    await response.json();
  }
}

async function listPass(origin, count) {
  for (let index = 0; index < count; index += 1) {
    const response = await request(origin, '/feed', { expect: 200 });
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('list did not return an array');
  }
}

async function updatePass(origin, count, ids) {
  for (let index = 0; index < count; index += 1) {
    const id = ids[index % ids.length];
    const response = await request(origin, `/notes/${id}`, {
      method: 'PATCH',
      body: { count: index, done: index % 2 === 1, title: `u${index}` },
      expect: 200,
    });
    await response.json();
  }
}

async function timed(count, run) {
  const started = process.hrtime.bigint();
  await run();
  const elapsedNs = Number(process.hrtime.bigint() - started);
  if (!Number.isFinite(elapsedNs) || elapsedNs <= 0) throw new Error('invalid benchmark duration');
  return (count * 1e9) / elapsedNs;
}

function geometricMean(values) {
  const logSum = values.reduce((sum, value) => sum + Math.log(value), 0);
  return Math.exp(logSum / values.length);
}

function round(value) {
  const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function summarize(values) {
  if (values.length === 0) throw new Error('cannot summarize an empty sample set');
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const standardDeviation = Math.sqrt(variance);

  return {
    sample_ops_s: values.map(round),
    min_ops_s: round(sorted[0]),
    median_ops_s: round(median),
    mean_ops_s: round(mean),
    stddev_ops_s: round(standardDeviation),
    relative_stddev_pct: round(mean === 0 ? 0 : (standardDeviation / mean) * 100),
    max_ops_s: round(sorted[sorted.length - 1]),
  };
}

async function runHttpSample(config) {
  const db = new DatabaseSync(':memory:');
  let app;
  try {
    app = workbench({ db, log: { level: 'warn' } });
    app.mount('/notes', ownedNote());
    app.mount('/feed', ownedFeed());
    app.listen(0, { principalOf: () => me });
    await app.ready;

    const address = app.httpServer.address();
    if (!address || typeof address === 'string' || address.port == null) {
      throw new Error('benchmark server did not expose a TCP port');
    }
    const origin = `http://127.0.0.1:${address.port}`;

    const insert = db.prepare(
      'INSERT INTO Feed (id, title, body, count, done, owner) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let index = 0; index < config.listSeed; index += 1) {
      insert.run(randomUUID(), `feed${index}`, `body${index}`, index, index % 2, 'bench-user');
    }

    const check = await request(origin, '/feed', { expect: 200 });
    const seeded = await check.json();
    if (!Array.isArray(seeded) || seeded.length !== config.listSeed) {
      throw new Error(
        `list sanity check: expected ${config.listSeed} rows, got ${Array.isArray(seeded) ? seeded.length : typeof seeded}`,
      );
    }

    // Warm the same request shapes that are timed. Warmup rows remain in the
    // database intentionally: the measured phases should see a warmed, growing
    // table rather than an empty-table special case.
    const warmIds = [];
    for (let index = 0; index < config.warmup; index += 1) {
      await createPass(origin, 1, warmIds);
      await readPass(origin, 1, warmIds);
      await listPass(origin, 1);
    }

    const ids = [];
    const createOps = await timed(config.create, () => createPass(origin, config.create, ids));
    if (ids.length === 0) throw new Error('create phase produced no ids');
    const readOps = await timed(config.read, () => readPass(origin, config.read, ids));
    const listOps = await timed(config.list, () => listPass(origin, config.list));
    const updateOps = await timed(config.update, () => updatePass(origin, config.update, ids));

    const phaseOps = [createOps, readOps, listOps, updateOps];
    return {
      create_ops_s: createOps,
      read_ops_s: readOps,
      list_ops_s: listOps,
      update_ops_s: updateOps,
      composite_ops_s: geometricMean(phaseOps),
    };
  } finally {
    if (app) await app.shutdown();
    db.close();
  }
}

function compileEntities(config) {
  const entities = [];
  for (let entityIndex = 0; entityIndex < config.entities; entityIndex += 1) {
    const fields = {};
    for (let fieldIndex = 0; fieldIndex < config.fields; fieldIndex += 1) {
      fields[`text${fieldIndex}`] = fieldIndex % 3 === 0
        ? text()
        : fieldIndex % 3 === 1 ? number() : boolean();
    }
    fields.grant = () => [
      scope(() => everyone()).can(() => grant(read, write, subscribe)),
    ];
    entities.push(entity(`BenchEntity${entityIndex}`, fields));
  }
  return entities;
}

async function runCompileSample(config) {
  const schemaOps = await timed(config.apps, () => {
    const db = new DatabaseSync(':memory:');
    try {
      executeFrameworkDDL(db);
      for (const declaration of compileEntities(config)) executeDDL(declaration, db);
    } finally {
      db.close();
    }
  });
  return { schema_prepare_ops_s: schemaOps, composite_ops_s: schemaOps };
}

function commitServer(db) {
  executeFrameworkDDL(db);
  return createServer({
    db,
    authorize: async () => true,
    pipeline: durableMutationVariant(),
    handlers: {
      'Probe.add': ({ payload, scope: actionScope }) => [{
        type: 'Probe.added',
        scope: actionScope,
        data: payload,
      }],
    },
  });
}

function assertCommitResult(result, expectedEvents, label) {
  if (!result?.ok || result.events?.length !== expectedEvents) {
    throw new Error(`${label} produced an invalid commit result`);
  }
}

async function runCommitSample(config) {
  const db = new DatabaseSync(':memory:');
  const server = commitServer(db);
  const principalOf = { type: 'system', id: 'bench' };
  const scopeKey = 'Probe:p1';
  try {
    for (let index = 0; index < config.warmup; index += 1) {
      const result = await server.dispatch({
        actionId: `warm-${index}`,
        type: 'Probe.add',
        scope: scopeKey,
        payload: { value: index },
        principal: principalOf,
      });
      assertCommitResult(result, 1, 'warmup');
    }

    const dispatchOps = await timed(config.dispatch, async () => {
      for (let index = 0; index < config.dispatch; index += 1) {
        const result = await server.dispatch({
          actionId: `dispatch-${index}`,
          type: 'Probe.add',
          scope: scopeKey,
          payload: { value: index },
          principal: principalOf,
        });
        assertCommitResult(result, 1, 'dispatch');
      }
    });

    const dedupeAction = {
      actionId: 'dedupe-seed',
      type: 'Probe.add',
      scope: scopeKey,
      payload: { value: 'dedupe' },
      principal: principalOf,
    };
    assertCommitResult(await server.dispatch(dedupeAction), 1, 'dedupe seed');
    const dedupeOps = await timed(config.dedupe, async () => {
      for (let index = 0; index < config.dedupe; index += 1) {
        const result = await server.dispatch(dedupeAction);
        assertCommitResult(result, 1, 'dedupe');
        if (!result.deduped) throw new Error('dedupe did not use the receipt path');
      }
    });

    const batchOps = await timed(config.batch * config.batchSize, async () => {
      for (let batchIndex = 0; batchIndex < config.batch; batchIndex += 1) {
        const actions = Array.from({ length: config.batchSize }, (_, actionIndex) => ({
          type: 'Probe.add',
          payload: { value: `${batchIndex}:${actionIndex}` },
        }));
        const result = await server.dispatchBatch({
          actionId: `batch-${batchIndex}`,
          actions,
          scope: scopeKey,
          principal: principalOf,
        });
        assertCommitResult(result, config.batchSize, 'batch');
      }
    });

    return {
      dispatch_ops_s: dispatchOps,
      dedupe_ops_s: dedupeOps,
      batch_action_ops_s: batchOps,
      composite_ops_s: geometricMean([dispatchOps, dedupeOps, batchOps]),
    };
  } finally {
    db.close();
  }
}

function appendLiveEvent(db, scopeKey, seq, value) {
  db.prepare(
    `INSERT INTO _Log (scope, seq, eventType, eventData, actionId, committedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    scopeKey,
    seq,
    'Note.updated',
    JSON.stringify({ value }),
    `live-${seq}`,
    new Date().toISOString(),
  );
  db.prepare(
    `INSERT INTO _Cursor (scope, lastSeq) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET lastSeq = excluded.lastSeq`,
  ).run(scopeKey, seq);
}

function liveEntityRecord() {
  return {
    name: 'Note',
    hydrate: (row) => ({ ...row }),
    scopeFilter: () => ({ sql: '1=1', params: {} }),
    grant: () => [scope(() => everyone()).can(() => grant(read, subscribe))],
    registry: {},
  };
}

async function runLiveDeliverySample(config) {
  const db = new DatabaseSync(':memory:');
  const scopeKey = 'Note:n1';
  db.exec('CREATE TABLE Note (id TEXT PRIMARY KEY, title TEXT, owner TEXT)');
  db.prepare('INSERT INTO Note (id, title, owner) VALUES (?, ?, ?)').run('n1', 'bench', 'bench-user');
  executeFrameworkDDL(db);
  for (let seq = 1; seq <= config.history; seq += 1) appendLiveEvent(db, scopeKey, seq, seq);

  const core = createLiveDeliveryCore({
    db,
    entities: new Map([['Note', liveEntityRecord()]]),
    mayVerb: async () => true,
    projectRecipient: ({ event, scope: eventScope }) => [{
      scope: eventScope,
      seq: event.seq,
      type: event.eventType,
      data: event.data,
    }],
  });
  const principalOf = { type: 'user', id: 'bench-user' };

  try {
    const catchupOps = await timed(config.history * config.subscribers, async () => {
      for (let subscriber = 0; subscriber < config.subscribers; subscriber += 1) {
        const result = await core.catchup({ principal: principalOf, scope: scopeKey, after: 0 });
        if (result.kind !== 'catchup' || result.envelopes.length !== config.history) {
          throw new Error('live catch-up returned an unexpected event count');
        }
      }
    });

    let delivered = 0;
    let expected = 0;
    let resolveDelivery;
    const deliver = async (batch) => {
      delivered += batch.length;
      if (delivered >= expected) resolveDelivery?.();
    };
    for (let subscriber = 0; subscriber < config.subscribers; subscriber += 1) {
      await core.subscribe({
        principal: principalOf,
        scope: scopeKey,
        after: config.history,
        signal: null,
        deliver,
      });
    }

    const fanoutOps = await timed(config.fanout * config.subscribers, async () => {
      for (let index = 0; index < config.fanout; index += 1) {
        expected += config.subscribers;
        const deliveredThisWake = new Promise((resolve) => { resolveDelivery = resolve; });
        appendLiveEvent(db, scopeKey, config.history + index + 1, index);
        await core.wake(scopeKey);
        await deliveredThisWake;
        resolveDelivery = undefined;
      }
    });

    return {
      catchup_event_ops_s: catchupOps,
      fanout_delivery_ops_s: fanoutOps,
      composite_ops_s: geometricMean([catchupOps, fanoutOps]),
    };
  } finally {
    core.close();
    db.close();
  }
}

function textActor(index) {
  return index.toString(16).padStart(32, '0');
}

function textWorkloadText(lines) {
  const words = Array.from({ length: 10 }, (_, index) => `word${index}`).join(' ');
  return Array.from({ length: lines }, (_, index) => `${words} ${index}`).join('\n');
}

function textOperation(index) {
  return [
    'workbench.text',
    1,
    [textActor(index + 1), 1],
    index + 2,
    [],
    ['insert', ['root'], 'x'],
  ];
}

function textFamilyFor(config) {
  let family = importTextToFamily('bench-document', textActor(0), textWorkloadText(config.lines));
  for (let index = 0; index < config.operations; index += 1) {
    family = applyTextOperation(family, textOperation(index));
  }
  return family;
}

async function runAnnotatedTextSample(config) {
  const family = textFamilyFor(config);
  const checkpoint = JSON.stringify({ id: family.id, checkpoint: textFamilyCheckpoint(family).checkpoint });
  const materializeOps = await timed(config.operations, () => {
    let length = 0;
    for (let index = 0; index < config.operations; index += 1) length += materializeText(family).length;
    return length;
  });
  const restoreOps = await timed(config.operations, () => {
    let length = 0;
    for (let index = 0; index < config.operations; index += 1) {
      length += materializeText(restoreTextFamily(JSON.parse(checkpoint))).length;
    }
    return length;
  });
  let nextFamily = family;
  let nextOperation = config.operations + 1;
  const applyOps = await timed(config.operations, () => {
    let length = 0;
    for (let index = 0; index < config.operations; index += 1) {
      nextFamily = applyTextOperation(nextFamily, textOperation(nextOperation));
      nextOperation += 1;
      length += materializeText(nextFamily).length;
    }
    return length;
  });

  return {
    materialize_ops_s: materializeOps,
    restore_materialize_ops_s: restoreOps,
    apply_materialize_ops_s: applyOps,
    composite_ops_s: geometricMean([materializeOps, restoreOps, applyOps]),
  };
}

// The unified annotated-text declaration: independent typed timing and
// confidence families (exact common geometry interns one shared immutable
// range), a comment family, and declaration-owned correct/revise actions that
// route through the Commit loop rather than a separately registered contract.
function unifiedAnnotationDocument() {
  const nonNegativeMs = (value) => Number.isSafeInteger(value) && value >= 0;
  const unitConfidence = (value) => typeof value === 'number' && value >= 0 && value <= 1;
  return entity('UnifiedDoc', {
    project: ref('Project'),
    owner: ref('User', { role: 'owner' }),
    body: annotatedText({
      project: 'project',
      owner: 'owner',
      annotations: [
        annotation('timing', {
          fields: {
            startMs: number({ validate: nonNegativeMs }),
            durationMs: number({ validate: nonNegativeMs }),
          },
          actions: {
            correct: annotationAction({
              input: {
                startMs: number({ validate: nonNegativeMs }),
                durationMs: number({ validate: nonNegativeMs }),
              },
              change: ({ input }) => ({ fields: input }),
            }),
          },
        }),
        annotation('transcriptionConfidence', {
          fields: { confidence: number({ validate: unitConfidence }) },
          actions: {
            revise: annotationAction({
              input: { confidence: number({ validate: unitConfidence }) },
              change: ({ input }) => ({ fields: input }),
            }),
          },
        }),
        annotation('comment', { empty: 'orphan' }),
      ],
    }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function unifiedProjectEntity() {
  return entity('Project', {
    owner: ref('User', { role: 'owner' }),
    grant: [scope(() => everyone()).can(() => grant(read, write))],
  });
}

function unifiedSourceText(annotations) {
  return Array.from({ length: annotations }, (_, index) => `word${index}`).join(' ');
}

function unifiedSourceRanges(annotations, text) {
  const ranges = [];
  const widths = text.split(' ').map((word) => word.length);
  let offset = 0;
  for (let index = 0; index < annotations; index += 1) {
    const width = widths[index];
    ranges.push({
      annotationId: `timing-${index}`, family: 'timing',
      start: offset, end: offset + width,
      fields: { startMs: index * 10, durationMs: 5 },
    });
    ranges.push({
      annotationId: `confidence-${index}`, family: 'transcriptionConfidence',
      start: offset, end: offset + width,
      fields: { confidence: 0.9 },
    });
    offset += width + 1;
  }
  return ranges;
}

function unifiedFrameworkDb() {
  const db = new DatabaseSync(':memory:');
  executeFrameworkDDL(db);
  db.exec('CREATE TABLE User (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO User (id) VALUES ('bench-user')");
  return db;
}

async function unifiedAuthoringBinding(db, Doc) {
  const prefix = 'UnifiedDoc_body';
  const clientNonce = 'a'.repeat(43);
  const stream = ensureStream({
    db, prefix, documentId: 'd1', principalType: 'user', principalId: 'bench-user',
  });
  const lease = ensureLease({
    db, prefix, streamId: stream.id, clientNonceHash: hashClientNonce(clientNonce),
  });
  const row = db.prepare("SELECT * FROM UnifiedDoc WHERE id = 'd1'").get();
  const snapshot = await projectAnnotatedTextSnapshot({
    db, entity: Doc, row, principal: me,
    fieldName: 'body', descriptor: Doc.fields.body,
    authoring: {
      streamToken: stream.id, leaseToken: lease.id, leaseId: lease.id,
      clientNonceHash: hashClientNonce(clientNonce), fence: 0,
    },
  });
  return { documentPositionToken: snapshot.authoring.positionFrames[0].positionToken };
}

async function runUnifiedAnnotatedTextSample(config) {
  const Doc = unifiedAnnotationDocument();
  const Project = unifiedProjectEntity();

  // Declaration compilation: fresh schema preparation including the typed
  // timing/confidence extension tables, the immutable range relation, and the
  // membership relation.
  const compileOps = await timed(config.apps, () => {
    const db = unifiedFrameworkDb();
    try {
      executeDDL(Project, db);
      db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'bench-user')");
      executeDDL(Doc, db);
    } finally {
      db.close();
    }
  });

  const db = unifiedFrameworkDb();
  let app;
  try {
    executeDDL(Project, db);
    db.exec("INSERT INTO Project (id, owner) VALUES ('p1', 'bench-user')");
    executeDDL(Doc, db);
    app = workbench({ db, entities: [Project, Doc], log: { level: 'warn' } });
    await app.start();
    await app.ready;

    const text = unifiedSourceText(config.annotations);
    const ranges = unifiedSourceRanges(config.annotations, text);
    const annotationRows = ranges.length;

    // Batch commit: one atomic transcript import through the ordinary Commit
    // loop (one created Event, one projection).
    const importOps = await timed(annotationRows, async () => {
      const result = await app.dispatch({
        actionId: 'bench-import', type: 'UnifiedDoc.create', scope: 'Project:p1',
        payload: { id: 'd1', project: 'p1', owner: 'bench-user', body: { version: 1, blocks: [{ text }], ranges } },
        principal: me,
      });
      if (!result?.ok) throw new Error(`unified import failed: ${result?.failure?.message}`);
    });

    // Eager snapshot: one canonical recipient projection assembled with a
    // bounded query count (flat as annotation count grows).
    const row = db.prepare("SELECT * FROM UnifiedDoc WHERE id = 'd1'").get();
    let recipient;
    const snapshotOps = await timed(annotationRows, () => {
      recipient = projectAnnotatedTextSnapshot({
        db, entity: Doc, row, principal: me,
        fieldName: 'body', descriptor: Doc.fields.body, mintBasis: false,
      });
    });
    recipient = await recipient;

    // Serialization: the recipient snapshot over the wire.
    const serializeOps = await timed(annotationRows, () => { JSON.stringify(recipient); });

    // Client reconciliation: materialize the client's annotated document view
    // from the canonical recipient snapshot. A fully-visible recipient is v3:
    // compact endpoint tables that only resolve against a family replica, so
    // production consumers restore one from the durable family checkpoint
    // (the live client seeds the same checkpoint from its authoring envelope).
    // The replica is a one-time client bootstrap, so it is restored outside
    // the timed loop exactly once, mirroring a live session's familyReplica.
    const familyCheckpoint = readAnnotatedTextFamilyCheckpoint(db, 'UnifiedDoc_body', 'd1');
    if (familyCheckpoint === undefined) throw new Error('unified materialize failed: family checkpoint is missing');
    const familyReplica = restoreTextFamilySerialized(familyCheckpoint);
    const materializeOps = await timed(annotationRows, () => {
      materializeAnnotatedTextSnapshot(recipient, Doc.body, { family: familyReplica });
    });

    // Declaration action: timing.correct through the Commit loop against one
    // stable authoring position frame. Every dispatch runs inside the timed
    // window so the metric is per-dispatch throughput, like the other phases.
    const binding = await unifiedAuthoringBinding(db, Doc);
    const correctOps = await timed(config.corrects, async () => {
      for (let index = 0; index < config.corrects; index += 1) {
        const result = await app.dispatch({
          actionId: `bench-correct-${Math.random().toString(36).slice(2)}`,
          type: 'UnifiedDoc.body.timing.correct', scope: 'Project:p1', principal: me,
          payload: {
            version: 1, id: 'd1', basis: binding.documentPositionToken, mutationId: 'bench-correct',
            from: 0, to: 5, values: { startMs: 0, durationMs: 10 },
          },
        });
        if (!result?.ok) throw new Error(`unified correct failed: ${result?.failure?.message}`);
      }
    });

    return {
      compile_app_ops_s: compileOps,
      import_annotation_ops_s: importOps,
      snapshot_annotation_ops_s: snapshotOps,
      serialize_annotation_ops_s: serializeOps,
      materialize_annotation_ops_s: materializeOps,
      declaration_action_ops_s: correctOps,
      composite_ops_s: geometricMean([compileOps, importOps, snapshotOps, serializeOps, materializeOps, correctOps]),
    };
  } finally {
    if (app) await app.shutdown();
    db.close();
  }
}

function operationsFor(config) {
  return { ...config };
}

async function runWorkload(benchmark, name, config, samples, sampleRunner) {
  const workloadName = `${benchmark}/${name}`;
  log(`${workloadName}: ${samples} samples`);
  const results = [];
  for (let sample = 1; sample <= samples; sample += 1) {
    const result = await sampleRunner(config);
    results.push(result);
    const summary = Object.entries(result)
      .filter(([, value]) => Number.isFinite(value))
      .map(([metric, value]) => `${metric.replace(/_ops_s$/, '')} ${value.toFixed(0)}`)
      .join(' · ');
    log(
      `  sample ${sample}/${samples}: ${summary} ops/s`,
    );
  }

  const metricNames = Object.keys(results[0]);
  const metrics = {};
  for (const metric of metricNames) metrics[metric] = summarize(results.map((result) => result[metric]));
  return {
    benchmark,
    name,
    operations: operationsFor(config),
    metrics,
  };
}

function inspectorPost(session, method) {
  return new Promise((resolveResult, reject) => {
    session.post(method, (error, result) => {
      if (error) reject(error);
      else resolveResult(result);
    });
  });
}

async function startCpuProfile(profilePath) {
  const outputPath = resolve(profilePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const session = new inspector.Session();
  session.connect();
  try {
    await inspectorPost(session, 'Profiler.enable');
    await inspectorPost(session, 'Profiler.start');
  } catch (error) {
    session.disconnect();
    throw new Error(`could not start CPU profiler: ${error?.message ?? error}`);
  }

  return async () => {
    let stopError;
    try {
      const result = await inspectorPost(session, 'Profiler.stop');
      if (!result?.profile) throw new Error('CPU profiler returned no profile');
      writeFileSync(outputPath, JSON.stringify(result.profile));
    } catch (error) {
      stopError = error;
    } finally {
      try { await inspectorPost(session, 'Profiler.disable'); } catch { /* best effort */ }
      session.disconnect();
    }
    if (stopError) throw new Error(`could not write CPU profile: ${stopError?.message ?? stopError}`);
  };
}

function readBaseline(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`could not read baseline '${path}': ${error?.message ?? error}`);
  }
  if (!value || value.schema_version !== SCHEMA_VERSION || value.benchmark !== BENCHMARK_NAME) {
    throw new Error(`baseline '${path}' is not a ${BENCHMARK_NAME} v${SCHEMA_VERSION} report`);
  }
  return value;
}

function compareReports(current, baseline, baselinePath, maxRegressionPct) {
  const workloadKey = (workload) => `${workload.benchmark ?? ''}/${workload.name}`;
  const baselineByName = new Map((baseline.workloads ?? []).map((workload) => [workloadKey(workload), workload]));
  const checks = [];

  for (const workload of current.workloads) {
    const key = workloadKey(workload);
    const previous = baselineByName.get(key);
    if (!previous) throw new Error(`baseline has no '${key}' workload`);
    if (JSON.stringify(previous.operations) !== JSON.stringify(workload.operations)) {
      throw new Error(`baseline '${key}' workload operations do not match current run`);
    }

    for (const metric of Object.keys(workload.metrics ?? {})) {
      const baselineMedian = previous.metrics?.[metric]?.median_ops_s;
      const currentMedian = workload.metrics?.[metric]?.median_ops_s;
      if (!Number.isFinite(baselineMedian) || baselineMedian <= 0) {
        throw new Error(`baseline '${key}' metric '${metric}' has no positive median`);
      }
      if (!Number.isFinite(currentMedian) || currentMedian <= 0) {
        throw new Error(`current '${key}' metric '${metric}' has no positive median`);
      }

      const changePct = ((currentMedian - baselineMedian) / baselineMedian) * 100;
      const regressionPct = Math.max(0, -changePct);
      checks.push({
        workload: key,
        metric,
        baseline_median_ops_s: baselineMedian,
        current_median_ops_s: currentMedian,
        change_pct: round(changePct),
        regression_pct: round(regressionPct),
        passed: regressionPct <= maxRegressionPct,
      });
    }
  }

  return {
    baseline: baselinePath,
    max_regression_pct: maxRegressionPct,
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function gitOutput(argumentsList) {
  const result = spawnSync('git', argumentsList, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function gitContext() {
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status === null) return { clean: false, commit: null, reason: 'git status unavailable' };
  if (status !== '') return { clean: false, commit: null, reason: 'worktree had uncommitted changes' };
  const commit = gitOutput(['rev-parse', 'HEAD']);
  if (!commit) return { clean: false, commit: null, reason: 'HEAD unavailable' };
  return { clean: true, commit, reason: null };
}

function stableGitContext(start, end) {
  if (start.clean && end.clean && start.commit === end.commit) {
    return { clean: true, commit: start.commit, reason: null };
  }
  const reason = start.reason ?? end.reason ?? 'worktree changed while benchmarking';
  return { clean: false, commit: null, reason };
}

function workloadParameters(workload) {
  const config = workload.operations;
  if (workload.benchmark === 'compile') {
    return `${config.apps} fresh in-memory schema preparations; ${config.entities} Entity declarations per preparation; ${config.fields} fields per Entity; framework DDL included`;
  }
  if (workload.benchmark === 'http-crud') {
    return `${config.warmup} warmup cycles; ${config.create} creates, ${config.read} reads, ${config.list} lists, ${config.update} updates; ${config.listSeed} seeded Feed rows; sequential requests; JSON bodies with title/body/count/done`;
  }
  if (workload.benchmark === 'commit') {
    return `${config.warmup} warmup dispatches; ${config.dispatch} new durable dispatches; ${config.dedupe} retries of one committed action ID; ${config.batch} batches of ${config.batchSize} actions; one Probe scope`;
  }
  if (workload.benchmark === 'live-delivery') {
    return `${config.history} seeded history events; ${config.subscribers} authorized subscribers; ${config.fanout} new events fanned out to every subscriber; one Note scope`;
  }
  if (workload.benchmark === 'annotated-text') {
    return `${config.textChars} UTF-16 characters across ${config.lines} lines; ${config.operations} CRDT operations; cached materialization, checkpoint restore, and apply-plus-materialize phases`;
  }
  if (workload.benchmark === 'annotated-text-unified') {
    return `${config.annotations} timing/confidence range pairs imported in one atomic Commit-loop batch; ${config.apps} fresh schema preparations; eager snapshot, serialization, client materialization, and ${config.corrects} declaration-action dispatches against one authoring frame`;
  }
  return JSON.stringify(config);
}

function markdownCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderResultsMarkdown(report, source, recordPath) {
  const lines = [
    '# Performance Results',
    '',
    '> Generated by `bench/hot-path.mjs`. This file contains the latest recorded run; use the JSON report or a committed result for CI-grade comparison.',
    '',
    '## Run',
    '',
    `- Recorded at: \`${new Date().toISOString()}\``,
    `- Node: \`${process.version}\``,
    `- Platform: \`${process.platform}/${process.arch}\``,
    `- Report: \`${report.benchmark}\` schema \`v${report.schema_version}\``,
    `- Samples per workload: \`${report.samples}\``,
    `- Benchmark families: \`${report.benchmarks.join(', ')}\``,
    `- Sizes: \`${report.sizes.join(', ')}\``,
  ];
  if (source.clean) {
    lines.push(`- Git commit: \`${source.commit}\` (worktree clean before and after the run)`);
  } else {
    lines.push(`- Git commit: not recorded (${source.reason}; the worktree was not verified as a stable clean commit)`);
  }
  lines.push(
    '',
    '## Workload Parameters',
    '',
    '| Workload | Parameters | Exact operation configuration |',
    '| --- | --- | --- |',
  );
  for (const workload of report.workloads) {
    lines.push(
      `| ${workload.benchmark}/${workload.name} | ${markdownCell(workloadParameters(workload))} | \`${markdownCell(JSON.stringify(workload.operations))}\` |`,
    );
  }

  lines.push(
    '',
    '## Throughput',
    '',
    'Values are operations per second. The median is the primary reference number; sample values are included to show local variance.',
    '',
    '| Workload | Metric | Median | Mean | Min | Max | Relative stddev | Samples |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  );
  for (const workload of report.workloads) {
    for (const [metric, summary] of Object.entries(workload.metrics)) {
      lines.push(
        `| ${workload.benchmark}/${workload.name} | ${metric} | ${summary.median_ops_s} | ${summary.mean_ops_s} | ${summary.min_ops_s} | ${summary.max_ops_s} | ${summary.relative_stddev_pct}% | ${summary.sample_ops_s.join(', ')} |`,
      );
    }
  }

  lines.push(
    '',
    '## Interpretation',
    '',
    '- A run without a Git commit is a local directional measurement, not a versioned library expectation.',
    '- Compare runs with the same Node version, machine load, benchmark families, sizes, sample count, and operation configuration.',
    `- Markdown record path: \`${recordPath}\`.`,
    '',
  );
  return lines.join('\n');
}

function recordResults(report, source, recordPath) {
  const outputPath = resolve(recordPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${renderResultsMarkdown(report, source, recordPath)}\n`);
  log(`recorded Markdown results: ${recordPath}`);
}

const BENCHMARK_WORKLOADS = Object.freeze({
  compile: COMPILE_WORKLOADS,
  'http-crud': WORKLOADS,
  commit: COMMIT_WORKLOADS,
  'live-delivery': LIVE_WORKLOADS,
  'annotated-text': TEXT_WORKLOADS,
  'annotated-text-unified': UNIFIED_WORKLOADS,
});

const BENCHMARK_RUNNERS = Object.freeze({
  compile: runCompileSample,
  'http-crud': runHttpSample,
  commit: runCommitSample,
  'live-delivery': runLiveDeliverySample,
  'annotated-text': runAnnotatedTextSample,
  'annotated-text-unified': runUnifiedAnnotatedTextSample,
});

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const sourceAtStart = gitContext();
  const stopProfiler = options.profilePath ? await startCpuProfile(options.profilePath) : null;
  let report;
  try {
    const workloads = [];
    for (const benchmark of options.benchmarks) {
      for (const name of options.sizes) {
        workloads.push(await runWorkload(
          benchmark,
          name,
          BENCHMARK_WORKLOADS[benchmark][name],
          options.samples,
          BENCHMARK_RUNNERS[benchmark],
        ));
      }
    }
    report = {
      schema_version: SCHEMA_VERSION,
      benchmark: BENCHMARK_NAME,
      benchmarks: options.benchmarks,
      sizes: options.sizes,
      samples: options.samples,
      workloads,
      profile: options.profilePath
        ? { enabled: true, path: options.profilePath }
        : { enabled: false },
      comparison: null,
    };
  } finally {
    if (stopProfiler) await stopProfiler();
  }

  if (options.comparePath) {
    const baseline = readBaseline(options.comparePath);
    report.comparison = compareReports(
      report,
      baseline,
      options.comparePath,
      options.maxRegressionPct,
    );
  }

  if (options.recordPath) {
    const source = stableGitContext(sourceAtStart, gitContext());
    recordResults(report, source, options.recordPath);
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.comparison && !report.comparison.passed) process.exitCode = 1;
}

main().catch((error) => {
  const message = error?.message ?? String(error);
  log(`benchmark failed: ${message}`);
  process.stdout.write(`${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    benchmark: BENCHMARK_NAME,
    error: message,
  })}\n`);
  process.exitCode = 1;
});
