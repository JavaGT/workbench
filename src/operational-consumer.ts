import { createHash } from 'node:crypto';
import { sweepBehindCursor, upsertConsumerCursor } from './consumer-cursor.ts';
import type { DbHandle } from './driver.ts';
import { txn } from './driver.ts';
import type { LogRow } from './committed-log.ts';
import { decodeConsumerLogRowData, type LogRowLike } from './committed-log.ts';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
export type OperationalRetryReason =
  | 'canonical-unavailable'
  | 'invalid-event'
  | 'invariant-violation'
  | 'consumer-error'
  | 'retry';
const RETRY_REASONS: ReadonlySet<string> = new Set(['canonical-unavailable', 'invalid-event', 'invariant-violation', 'consumer-error', 'retry']);
/** Fixed, non-content descriptions exposed by the operator inventory. */
const FAILURE_DETAILS: Readonly<Record<string, string>> = {
  'canonical-unavailable': 'The consumer could not read its canonical evidence.',
  'invalid-event': 'The committed event could not be decoded or projected.',
  'invariant-violation': 'The consumer returned a result outside its contract.',
  'consumer-error': 'The consumer callback threw.',
  retry: 'The consumer requested another attempt.',
  terminal: 'The consumer reported a terminal failure.',
};
function failureDetail(code: string): string { return FAILURE_DETAILS[code] ?? 'The consumer reported a terminal failure.'; }
function retryReason(code: string | undefined): OperationalRetryReason {
  return code !== undefined && RETRY_REASONS.has(code) ? (code as OperationalRetryReason) : 'retry';
}
const cursorName = (name: string) => `operational:${name}`;

function fail(message: string): never { throw new TypeError(`operational consumer: ${message}`); }

function canonical(value: unknown): string { return JSON.stringify(value) as string; }

export interface OperationalConsumerMetadata {
  committedEventId: string;
  actionId: string;
  scopeId: string;
  eventType: string;
  committedAt: string;
}

export interface OperationalConsumerPartial {
  metadata: OperationalConsumerMetadata;
  payload: unknown;
  idempotencyKey?: string;
}

export interface OperationalConsumerAck {
  kind: 'ack';
}

export interface OperationalConsumerRetry {
  kind: 'retry';
  afterMs?: number;
  /** Stable, non-content reason code for operator inventory. */
  code?: string;
  detail?: string;
}

export interface OperationalConsumerTerminal {
  kind: 'terminal';
  code: string;
  detail: string;
}

export type OperationalConsumerResult = OperationalConsumerAck | OperationalConsumerRetry | OperationalConsumerTerminal;

export interface OperationalConsumerEvent {
  eventType: string;
  fields: readonly string[];
  project(fields: Readonly<Record<string, unknown>>, metadata: OperationalConsumerMetadata): unknown;
}

export interface OperationalConsumer {
  name: string;
  declarationVersion: string;
  event: OperationalConsumerEvent;
  projectionId: string;
  effectId: string;
  idempotencyKey(partial: OperationalConsumerPartial): string;
  handle(partial: OperationalConsumerPartial): Promise<OperationalConsumerResult>;
}

type FailureResult = {
  kind: 'retry' | 'terminal';
  afterMs?: number;
  code?: string;
  detail?: string;
};

function fingerprint(consumer: OperationalConsumer): string {
  return createHash('sha256').update(canonical({
    name: consumer.name,
    declarationVersion: consumer.declarationVersion,
    eventType: consumer.event.eventType,
    fields: consumer.event.fields,
    projectionId: consumer.projectionId,
    effectId: consumer.effectId,
  })).digest('hex');
}

function json(value: unknown, message: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined');
    return JSON.parse(encoded);
  } catch { fail(message); }
}

function validate(consumer: unknown): OperationalConsumer {
  if (!consumer || typeof consumer !== 'object') fail('must be an object');
  const record = consumer as Record<string, unknown>;
  for (const key of ['name', 'projectionId', 'effectId']) {
    const value = record[key];
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${key} must be an ASCII identifier`);
  }
  const declarationVersion = record.declarationVersion;
  if (typeof declarationVersion !== 'string' || declarationVersion.length === 0) fail('declarationVersion must be non-empty');
  const event = record.event as Record<string, unknown> | null | undefined;
  if (!event || typeof event.eventType !== 'string' || !Array.isArray(event.fields)
    || typeof event.project !== 'function') fail('event must declare eventType, fields, and project');
  const fields = event.fields as unknown[];
  if (new Set(fields).size !== fields.length || fields.some((field) => typeof field !== 'string')) fail('event fields must be unique strings');
  if (typeof record.idempotencyKey !== 'function' || typeof record.handle !== 'function') fail('idempotencyKey and handle are required');
  const normalizedEvent: OperationalConsumerEvent = {
    eventType: event.eventType as string,
    fields: Object.freeze([...fields] as string[]),
    project: event.project as OperationalConsumerEvent['project'],
  };
  return Object.freeze({
    name: record.name as string,
    declarationVersion,
    projectionId: record.projectionId as string,
    effectId: record.effectId as string,
    idempotencyKey: record.idempotencyKey as OperationalConsumer['idempotencyKey'],
    handle: record.handle as OperationalConsumer['handle'],
    event: Object.freeze(normalizedEvent),
  });
}

export function defineOperationalEvent(spec: OperationalConsumerEvent): OperationalConsumerEvent {
  return validate({ name: 'Temporary', declarationVersion: '1', projectionId: 'temporary', effectId: 'temporary', event: spec, idempotencyKey: () => 'temporary', handle: async () => ({ kind: 'ack' }) }).event;
}

export function operationalConsumer(consumer: unknown): OperationalConsumer { return validate(consumer); }

function metadata(row: LogRow): OperationalConsumerMetadata {
  return Object.freeze({
    committedEventId: `${row.scope}:${row.seq}`,
    actionId: row.actionId,
    scopeId: row.scope,
    eventType: row.eventType,
    committedAt: row.committedAt,
  });
}

export interface OperationalConsumersOptions {
  writeQueue?: { run<T>(fn: () => Promise<T> | T): Promise<T> } | null;
  onShutdown?: (name: string, hook: () => void | Promise<void>, options?: { timeoutMs?: number }) => void | unknown;
  now?: () => number;
}

export interface OperationalConsumers {
  engage(db: DbHandle): void;
  consumer(events: readonly unknown[], context: { db: DbHandle }): Promise<void>;
  reconcile(db: DbHandle): Promise<void>;
  declared: readonly OperationalConsumer[];
  stop(): void;
}

export function createOperationalConsumers(consumers: readonly unknown[] = [], {
  writeQueue,
  onShutdown,
  now = Date.now,
}: OperationalConsumersOptions = {}): OperationalConsumers {
  const declared = consumers.map(validate);
  const names = new Set<string>();
  for (const consumer of declared) {
    if (names.has(consumer.name)) fail(`duplicate name '${consumer.name}'`);
    names.add(consumer.name);
  }

  function engage(db: DbHandle) {
    for (const consumer of declared) {
      const declarationFingerprint = fingerprint(consumer);
      const existing = db.prepare('SELECT declarationFingerprint FROM _OperationalConsumerDeclaration WHERE name = ?').get(consumer.name);
      if (existing && existing.declarationFingerprint !== declarationFingerprint) {
        throw new Error(`operational consumer '${consumer.name}' declaration changed; use a new name`);
      }
      db.prepare('INSERT OR IGNORE INTO _OperationalConsumerDeclaration (name, declarationFingerprint) VALUES (?, ?)').run(consumer.name, declarationFingerprint);
    }
  }

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reconciling = false;
  let reconcileAgain = false;

  function clearRetryTimer() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function armRetryScheduler(db: DbHandle) {
    clearRetryTimer();
    if (stopped || declared.length === 0) return;
    const names = declared.map(({ name }) => name);
    const placeholders = names.map(() => '?').join(', ');
    const next = db.prepare(`SELECT MIN(nextAttemptAt) AS nextAttemptAt
      FROM _OperationalConsumerFailure
      WHERE status = 'retry' AND nextAttemptAt IS NOT NULL AND consumer IN (${placeholders})`).get(...names)?.nextAttemptAt;
    if (next == null) return;
    // A due retry still yields to the event loop, avoiding a zero-delay loop.
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      const run = () => reconcile(db);
      const queued = writeQueue ? writeQueue.run(run) : Promise.resolve().then(run);
      queued.catch(() => {}).finally(() => armRetryScheduler(db));
    }, Math.max(1, Number(next) - now()));
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  }

  if (onShutdown) onShutdown('operational consumer retry scheduler', () => {
    stopped = true;
    clearRetryTimer();
  }, { timeoutMs: 1000 });

  async function deliver(db: DbHandle, consumer: OperationalConsumer, row: LogRow): Promise<boolean> {
    const declarationFingerprint = fingerprint(consumer);
    const failed = db.prepare('SELECT status, nextAttemptAt FROM _OperationalConsumerFailure WHERE consumer = ? AND scope = ? AND committedEventId = ?')
      .get(consumer.name, row.scope, `${row.scope}:${row.seq}`);
    if (failed?.status === 'terminal' || (failed?.nextAttemptAt != null && Number(failed.nextAttemptAt) > now())) return false;
    let data: Record<string, unknown>;
    // Strict log-row decode (round 3): tampered v16 rows THROW so the failed
    // row is recorded and no consumer/projection work advances past it; only
    // malformed legacy (non-v16) rows degrade to {} as before.
    try {
      data = decodeConsumerLogRowData(row as unknown as LogRowLike, {});
    } catch {
      await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invalid-event' }, failureDetail('invalid-event'));
      return false;
    }
    const fields = Object.create(null) as Record<string, unknown>;
    for (const field of consumer.event.fields) fields[field] = data[field];
    let payload: unknown;
    try { payload = json(consumer.event.project(Object.freeze(fields), metadata(row)), 'projection result must be JSON serializable'); } catch {
      await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invalid-event' }, failureDetail('invalid-event'));
      return false;
    }
    const partial = Object.freeze({ metadata: metadata(row), payload });
    let idempotencyKey: string;
    try {
      idempotencyKey = consumer.idempotencyKey(partial);
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) fail('idempotencyKey must return a non-empty string');
      if (consumer.idempotencyKey(partial) !== idempotencyKey) fail('idempotencyKey must be deterministic');
    } catch { await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invariant-violation' }, failureDetail('invariant-violation')); return false; }
    let result: OperationalConsumerResult;
    try { result = await consumer.handle(Object.freeze({ ...partial, idempotencyKey })); } catch { result = { kind: 'retry', afterMs: 0, code: 'consumer-error' }; }
    if (!result || !['ack', 'retry', 'terminal'].includes(result.kind)) {
      await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invariant-violation' }, failureDetail('invariant-violation'));
      return false;
    }
    if (result.kind === 'retry' && (!Number.isFinite(result.afterMs) || Number(result.afterMs) < 0)) {
      await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invariant-violation' }, failureDetail('invariant-violation'));
      return false;
    }
    if (result.kind === 'retry' && result.code !== undefined && (typeof result.code !== 'string' || !IDENTIFIER.test(result.code))) {
      await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invariant-violation' }, failureDetail('invariant-violation'));
      return false;
    }
    if (result.kind === 'terminal' && (typeof result.code !== 'string' || !IDENTIFIER.test(result.code) || typeof result.detail !== 'string')) {
      await recordFailure(db, consumer, row, declarationFingerprint, { kind: 'retry', afterMs: 0, code: 'invalid-event' }, failureDetail('invalid-event'));
      return false;
    }
    if (result.kind === 'ack') {
      await txn(db, () => {
        db.prepare('DELETE FROM _OperationalConsumerFailure WHERE consumer = ? AND scope = ? AND committedEventId = ?').run(consumer.name, row.scope, `${row.scope}:${row.seq}`);
        upsertConsumerCursor(db, { consumer: cursorName(consumer.name), scope: row.scope, lastSeq: row.seq });
      });
      return true;
    }
    await recordFailure(db, consumer, row, declarationFingerprint, result, result.detail ?? 'consumer did not acknowledge');
    return false;
  }

  async function recordFailure(db: DbHandle, consumer: OperationalConsumer, row: LogRow, declarationFingerprint: string, result: FailureResult, detail: string): Promise<void> {
    const terminal = result.kind === 'terminal';
    // Persist only a typed reason and a fixed description. Consumer detail and
    // thrown errors may carry payload text and never reach the durable row.
    const code = terminal ? String(result.code ?? 'terminal') : retryReason(result.code);
    const safeDetail = terminal ? (result.code ? failureDetail(String(result.code)) : detail) : failureDetail(code);
    await txn(db, () => db.prepare(`INSERT INTO _OperationalConsumerFailure
      (consumer, scope, committedEventId, declarationFingerprint, code, detail, status, nextAttemptAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(consumer, scope, committedEventId) DO UPDATE SET code = excluded.code, detail = excluded.detail, status = excluded.status, nextAttemptAt = excluded.nextAttemptAt`)
      .run(consumer.name, row.scope, `${row.scope}:${row.seq}`, declarationFingerprint, code, safeDetail, terminal ? 'terminal' : 'retry', terminal ? null : now() + Math.max(0, Math.ceil(Number(result.afterMs) || 0))));
  }

  async function reconcile(db: DbHandle): Promise<void> {
    // A consumer may dispatch another Workbench action (for example, a
    // durable notification) while its current delivery is still in flight.
    // The nested post-commit hook must not sweep the same cursor row again
    // before the outer delivery has acknowledged it. Defer one follow-up
    // sweep until the outer cursor update completes instead.
    if (reconciling) {
      reconcileAgain = true;
      return;
    }
    reconciling = true;
    engage(db);
    try {
      for (const consumer of declared) {
        await sweepBehindCursor(db, cursorName(consumer.name), async (row) => {
          if (row.eventType !== consumer.event.eventType) return 'skip';
          return (await deliver(db, consumer, row)) ? 'done' : 'block';
        });
      }
    } finally {
      reconciling = false;
      armRetryScheduler(db);
      if (reconcileAgain && !stopped) {
        reconcileAgain = false;
        const queued = writeQueue ? writeQueue.run(() => reconcile(db)) : Promise.resolve().then(() => reconcile(db));
        queued.catch(() => {}).finally(() => armRetryScheduler(db));
      }
    }
  }

  const consumer = async (_events: readonly unknown[], { db }: { db: DbHandle }) => { await reconcile(db); };
  return { engage, consumer, reconcile, declared, stop: () => { stopped = true; clearRetryTimer(); } };
}

export interface OperationalConsumerAdminWorkbench {
  db: DbHandle;
  writeQueue?: { run<T>(fn: () => Promise<T> | T): Promise<T> } | null;
  reconcileOperationalConsumers?: (() => unknown) | null;
}

export function operationalConsumerAdmin(workbench: OperationalConsumerAdminWorkbench) {
  return {
    async listFailures(consumer: string) {
      return workbench.db.prepare(`SELECT consumer, scope AS scopeId, committedEventId, declarationFingerprint, code, detail, status
        FROM _OperationalConsumerFailure WHERE consumer = ? AND status = 'terminal' ORDER BY scope, committedEventId`).all(consumer);
    },
    async listRetries(consumer: string) {
      const rows = workbench.db.prepare(`SELECT consumer, scope AS scopeId, committedEventId, code, status, nextAttemptAt
        FROM _OperationalConsumerFailure WHERE consumer = ? AND status = 'retry' AND nextAttemptAt IS NOT NULL
        ORDER BY nextAttemptAt, scope, committedEventId`).all(consumer);
      return rows.map((row) => ({ ...row, code: retryReason(typeof (row as { code?: unknown }).code === 'string' ? (row as { code: string }).code : undefined) }));
    },
    async retryFailure(failure: { consumer: string; scopeId: string; committedEventId: string }) {
      const update = () => workbench.db.prepare(`UPDATE _OperationalConsumerFailure SET status = 'retry', nextAttemptAt = 0
        WHERE consumer = ? AND scope = ? AND committedEventId = ? AND status = 'terminal'`).run(failure.consumer, failure.scopeId, failure.committedEventId);
      const result = await (workbench.writeQueue ? workbench.writeQueue.run(update) : update());
      if (!result.changes) throw new Error('operational terminal failure not found');
      const reconcile = () => workbench.reconcileOperationalConsumers?.();
      await (workbench.writeQueue ? workbench.writeQueue.run(reconcile) : reconcile());
    },
  };
}
