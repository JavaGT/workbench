// Transactionally declared post-commit work. Declarations join the mutation
// transaction, but Workbench never performs their external I/O. A privileged
// application-owned runner claims immutable descriptors after commit.

import type { DbHandle } from './driver.ts';
import { writeQueueForDatabase } from './pipeline-write-queue.ts';
import { recordFactDependencies } from './private-action-fact-dependency.ts';
import { isDeleteFact } from './annotated-text-delete-history.ts';
import { parseAnnotationTransition } from './annotation-transition.ts';
import { decodeLogRowData } from './committed-log.ts';
import {
  applicationPrivateFactView,
  compoundKindOf,
  parseCompoundContributionFact,
} from './compound-contribution-fact.ts';

const STATUS_PENDING = 'pending';
const STATUS_CLAIMED = 'claimed';
const STATUS_COMPLETED = 'completed';

function json(value: unknown, where: string): string {
  try { return JSON.stringify(value) as string; } catch { throw new TypeError(`${where} must be JSON-serializable`); }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${where} must be a non-empty string`);
  return value;
}

export interface NormalizedEffect {
  file: string;
  operation: string;
  key: string;
  verification: string;
  payload: unknown;
  ordinal: number;
}

function normalizeEffects(effects: unknown): NormalizedEffect[] {
  if (effects === undefined) return [];
  if (!Array.isArray(effects)) throw new TypeError('registered action effects must be an array');
  return effects.map((effect, ordinal) => {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) throw new TypeError(`registered action effect ${ordinal} must be an object`);
    const record = effect as { file?: unknown; operation?: unknown; key?: unknown; verification?: unknown; payload?: unknown };
    const file = assertText(record.file, `registered action effect ${ordinal}.file`);
    const operation = assertText(record.operation, `registered action effect ${ordinal}.operation`);
    const key = record.key === undefined ? file : assertText(record.key, `registered action effect ${ordinal}.key`);
    const verification = assertText(record.verification, `registered action effect ${ordinal}.verification`);
    const payload = record.payload ?? null;
    json(payload, `registered action effect ${ordinal}.payload`);
    return Object.freeze({ file, operation, key, verification, payload, ordinal });
  });
}

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function annotatedContribution(value: unknown): boolean {
  // Blockless (issue #33): a contribution is one document-scoped text.insert
  // operation — no blockId. A block-era contribution (with blockId) is still
  // recognized so stored history remains readable until migration.
  const record = value as ({
    kind?: unknown;
    opId?: unknown;
    anchor?: unknown;
    text?: unknown;
    scalarCount?: unknown;
    blockId?: unknown;
    overlapRemovals?: unknown;
    overlapPatches?: unknown;
    createdAnnotation?: unknown;
  } & Record<string, unknown>) | null | undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!record) return false;
  const keys = Object.keys(record as object);
  const required = ['kind', 'opId', 'anchor', 'text', 'scalarCount'];
  const legacyRequired = ['kind', 'blockId', 'opId', 'anchor', 'text', 'scalarCount'];
  const base = exactKeys(record as object, required) || exactKeys(record as object, legacyRequired);
  if (!base) {
    const allowed = new Set([...required, 'blockId', 'overlapRemovals', 'overlapPatches', 'createdAnnotation']);
    if (keys.some((key) => !allowed.has(key)) || !required.every((key) => Object.hasOwn(record as object, key))) return false;
  }
  if (Object.hasOwn(record as object, 'overlapRemovals') && !annotationEffectImages(record.overlapRemovals, 'annotationId')) return false;
  if (Object.hasOwn(record as object, 'createdAnnotation') && !annotationEffectImage(record.createdAnnotation, 'id')) return false;
  if (Object.hasOwn(record as object, 'overlapPatches') && !annotationPatches(record.overlapPatches)) return false;
  return (exactKeys(record as object, required) || exactKeys(record as object, legacyRequired)
    || keys.every((key) => [...required, 'blockId', 'overlapRemovals', 'overlapPatches', 'createdAnnotation'].includes(key)))
    && record?.kind === 'text.insert' && (!Object.hasOwn(record as object, 'blockId') || (typeof record?.blockId === 'string' && record.blockId.length > 0))
    && Array.isArray(record?.opId) && Array.isArray(record?.anchor) && typeof record?.text === 'string'
    && Number.isSafeInteger(record?.scalarCount) && (record?.scalarCount as number) > 0;
}

function plainJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function annotationEffectImage(value: unknown, idKey: 'id' | 'annotationId'): boolean {
  if (!plainJsonObject(value)) return false;
  const allowed = [idKey, 'family', 'fields', 'protectedTargetIds', 'memberships', 'empty'];
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || !Object.hasOwn(value, idKey) || typeof value[idKey] !== 'string' || !value[idKey]
    || typeof value.family !== 'string' || !value.family
    || !plainJsonObject(value.fields)
    || !Array.isArray(value.protectedTargetIds)
    || value.protectedTargetIds.some((id) => typeof id !== 'string' || !id)
    || !Array.isArray(value.memberships)) return false;
  const targets = value.protectedTargetIds as string[];
  if (targets.some((id, index) => index > 0 && targets[index - 1] >= id)) return false;
  let previousOrdinal = -1;
  for (const rawMembership of value.memberships) {
    const membership = rawMembership as Record<string, unknown>;
    const ordinal = membership.ordinal;
    if (!plainJsonObject(membership)
      || Object.keys(membership).sort().join() !== 'end,ordinal,start'
      || !Number.isSafeInteger(ordinal) || (ordinal as number) <= previousOrdinal
      || !plainJsonObject(membership.start) || !plainJsonObject(membership.end)) return false;
    previousOrdinal = ordinal as number;
    try { json(membership.start, 'annotation effect endpoint'); json(membership.end, 'annotation effect endpoint'); } catch { return false; }
  }
  if (Object.hasOwn(value, 'empty') && value.empty !== 'delete' && value.empty !== 'orphan') return false;
  for (const field of Object.values(value.fields)) {
    try { json(field, 'annotation effect field'); } catch { return false; }
  }
  return true;
}

function annotationEffectImages(value: unknown, idKey: 'id' | 'annotationId'): boolean {
  return Array.isArray(value) && value.every((entry) => annotationEffectImage(entry, idKey));
}

function annotationPatches(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!plainJsonObject(entry)
      || Object.keys(entry).sort().join() !== 'annotationId,family,newFields,originalFields'
      || typeof entry.annotationId !== 'string' || !entry.annotationId
      || typeof entry.family !== 'string' || !entry.family
      || !plainJsonObject(entry.originalFields) || !plainJsonObject(entry.newFields)) return false;
    for (const fields of [entry.originalFields, entry.newFields]) {
      for (const value of Object.values(fields)) {
        try { json(value, 'annotation effect field'); } catch { return false; }
      }
    }
    return true;
  });
}

interface PrivateFactLike {
  version?: unknown;
  kind?: unknown;
  documentId?: unknown;
  contribution?: unknown;
  linkage?: { outcome?: unknown; direction?: unknown; rootActionId?: unknown; targetActionId?: unknown } | null;
  redo?: unknown;
}

function annotatedPrivateFact(fact: PrivateFactLike): boolean {
  // Phase B (#134): validated v3 delete-contribution facts are durable
  // storage input — they carry the erasure prerequisite index and (Phase D)
  // the undo payload. Canonicality is delegated to the exact-key parser so
  // this gate can never drift from the algebra module. Checked BEFORE the v2
  // gate because v3 facts carry their own version contract.
  if (fact.kind === 'annotated-text.delete-contribution') return isDeleteFact(fact as unknown);
  if (fact.version !== 2 || typeof fact.documentId !== 'string' || fact.documentId.length === 0) return false;
  if (fact.kind === 'annotated-text.contribution') {
    const contributionKeys = ['version', 'kind', 'documentId', 'contribution',
      ...(Object.hasOwn(fact, 'overlapRemovals') ? ['overlapRemovals'] : []),
      ...(Object.hasOwn(fact, 'overlapPatches') ? ['overlapPatches'] : []),
      ...(Object.hasOwn(fact, 'annotationTransition') ? ['annotationTransition'] : [])];
    if (!exactKeys(fact, contributionKeys) || !annotatedContribution(fact.contribution)) return false;
    if (Object.hasOwn(fact, 'annotationTransition')) {
      try {
        parseAnnotationTransition((fact as { annotationTransition?: unknown }).annotationTransition);
      } catch {
        return false;
      }
    }
    return true;
  }
  // #174: a committed annotation.update binds its whole before/after images.
  if (fact.kind === 'annotated-text.annotation-update') {
    return exactKeys(fact, ['version', 'kind', 'documentId', 'contribution']) && annotatedUpdateContribution(fact.contribution);
  }
  if (fact.kind === 'annotated-text.barrier') return exactKeys(fact, ['version', 'kind', 'documentId']);
  if (fact.kind !== 'annotated-text.compensation' || !fact.linkage || typeof fact.linkage !== 'object' || Array.isArray(fact.linkage)) return false;
  const validContribution = (value: unknown) => annotatedContribution(value) || annotatedUpdateContribution(value);
  const compensationBase = ['version', 'kind', 'documentId', 'linkage', 'contribution', ...(fact.linkage.direction === 'undo' ? ['redo'] : [])];
  const keys = fact.linkage.outcome === 'applied'
    ? [...compensationBase,
      ...(Object.hasOwn(fact, 'overlapRemovals') ? ['overlapRemovals'] : []),
      ...(Object.hasOwn(fact, 'overlapPatches') ? ['overlapPatches'] : [])]
    : ['version', 'kind', 'documentId', 'linkage'];
  return exactKeys(fact, keys)
    && exactKeys(fact.linkage, ['rootActionId', 'targetActionId', 'direction', 'outcome'])
    && typeof fact.linkage.rootActionId === 'string' && fact.linkage.rootActionId.length > 0
    && typeof fact.linkage.targetActionId === 'string' && fact.linkage.targetActionId.length > 0
    && ['undo', 'redo'].includes(fact.linkage.direction as string) && ['applied', 'noop'].includes(fact.linkage.outcome as string)
    && (fact.linkage.outcome === 'noop' || (validContribution(fact.contribution) && (!Object.hasOwn(fact, 'redo') || validContribution(fact.redo))));
}

/** #174: one image side of an annotation.update transition. */
function annotatedUpdateImage(image: unknown): boolean {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return false;
  if (!exactKeys(image, ['fields', 'protectedTargetIds', 'ranges'])) return false;
  const record = image as { fields: unknown; protectedTargetIds: unknown; ranges: unknown };
  if (!record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) return false;
  for (const value of Object.values(record.fields)) {
    try { json(value, 'annotation-update image fields'); } catch { return false; }
  }
  if (!Array.isArray(record.protectedTargetIds) || record.protectedTargetIds.some((id) => typeof id !== 'string')) return false;
  let previousTarget: string | null = null;
  for (const id of record.protectedTargetIds) {
    if (previousTarget !== null && String(id) <= previousTarget) return false;
    previousTarget = String(id);
  }
  if (!Array.isArray(record.ranges) || record.ranges.length === 0) return false;
  for (const entry of record.ranges) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ['annotationId', 'ordinal', 'end', 'start'])) return false;
    const range = entry as { annotationId: unknown; ordinal: unknown; start: unknown; end: unknown };
    if (typeof range.annotationId !== 'string' || range.annotationId.length === 0 || !Number.isSafeInteger(range.ordinal)) return false;
    for (const endpoint of [range.start, range.end]) {
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) || !exactKeys(endpoint, ['point', 'basisFrontier'])) return false;
      const point = endpoint as { point: unknown; basisFrontier: unknown };
      try {
        json(point.point, 'annotation-update image endpoint');
        json(point.basisFrontier, 'annotation-update image endpoint');
      } catch { return false; }
    }
  }
  return true;
}

/** #174: the symmetric before/after contribution of an atomic update. */
function annotatedUpdateContribution(contribution: unknown): boolean {
  if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) return false;
  if (!exactKeys(contribution, ['after', 'annotationId', 'before', 'kind'])) return false;
  const record = contribution as { kind: unknown; annotationId: unknown; before: unknown; after: unknown };
  if (record.kind !== 'annotation.update' || typeof record.annotationId !== 'string' || record.annotationId.length === 0) return false;
  return annotatedUpdateImage(record.before) && annotatedUpdateImage(record.after);
}

export interface PostCommitEffectInput {
  file: string;
  operation: string;
  key?: string;
  verification: string;
  payload?: unknown;
}

export interface PostCommitEffect {
  file: string;
  operation: string;
  key: string;
  verification: string;
  payload: unknown;
}

export function postCommitEffect(input?: PostCommitEffectInput): PostCommitEffect {
  return Object.freeze({
    file: assertText(input?.file, 'postCommitEffect.file'),
    operation: assertText(input?.operation, 'postCommitEffect.operation'),
    key: input?.key === undefined ? assertText(input?.file, 'postCommitEffect.file') : assertText(input.key, 'postCommitEffect.key'),
    verification: assertText(input?.verification, 'postCommitEffect.verification'),
    payload: input?.payload ?? null,
  });
}

function canonicalPrivateFact(privateFact: unknown, required: boolean): { fact: Record<string, unknown>; factJson: string } | undefined {
  if (privateFact === undefined) {
    if (required) throw new TypeError('private-fact projection requires a privateFact with before and after properties');
    return undefined;
  }
  const factJson = json(privateFact, 'registered action privateFact');
  const fact = JSON.parse(factJson);
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('registered action privateFact must be an object');
  }
  // scope#992 rev 4: package-constructed compound envelopes are canonicalized
  // through the exact-key compound parser; the parser result (never the raw
  // object) is serialized into _PrivateActionFact.fact. Legacy behavior remains
  // unchanged for every other fact shape.
  if (compoundKindOf(fact) !== null) {
    let canonical;
    try {
      canonical = parseCompoundContributionFact(fact);
    } catch (error) {
      throw new TypeError(`registered action privateFact has invalid compound envelope: ${(error as Error).message}`);
    }
    const canonicalJsonText = JSON.stringify(canonical);
    return { fact: deepFreeze(canonical) as unknown as Record<string, unknown>, factJson: canonicalJsonText };
  }
  if (!annotatedPrivateFact(fact as PrivateFactLike) && (!Object.hasOwn(fact, 'before') || !Object.hasOwn(fact, 'after'))) {
    throw new TypeError('registered action privateFact must have before and after properties');
  }
  return { fact: deepFreeze(fact), factJson };
}

export function declarePostCommitEffectsInTxn(db: DbHandle, { scope, actionId, committedAt, privateFact, effects, requirePrivateFact = false }: {
  scope: string;
  actionId: string;
  committedAt: string;
  privateFact?: unknown;
  effects?: unknown;
  requirePrivateFact?: boolean;
}): Record<string, unknown> | undefined {
  const declared = normalizeEffects(effects);
  const canonical = canonicalPrivateFact(privateFact, requirePrivateFact || declared.length > 0);
  if (!canonical && declared.length === 0) return undefined;
  const { fact: canonicalFact, factJson } = canonical as { fact: Record<string, unknown>; factJson: string };
  const effectsJson = JSON.stringify(declared);
  const fact = db.prepare(
    `INSERT INTO _PrivateActionFact (scope, actionId, committedAt, fact, effects)
     VALUES (?, ?, ?, ?, ?)
     RETURNING originOrder`,
  ).get(scope, actionId, committedAt, factJson, effectsJson) as { originOrder: number };
  // Erasure prerequisite index (design §5): derive identities-only dependency
  // rows from the validated canonical fact in the same transaction. Facts
  // that depend on nothing record nothing; a malformed fact can never reach
  // this line because canonicalization already failed closed.
  recordFactDependencies(db, { scope, actionId, canonicalFact });
  const insert = db.prepare(
    `INSERT INTO _PostCommitEffect
      (scope, actionId, file, operation, ordinal, originOrder, exclusionKey, verification, payload, declaredAt, status, fence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (const effect of declared) {
    insert.run(scope, actionId, effect.file, effect.operation, effect.ordinal, fact.originOrder, effect.key,
      effect.verification, JSON.stringify(effect.payload), committedAt, STATUS_PENDING);
  }
  return canonicalFact;
}

function parseJson(value: string, where: string): unknown {
  try { return JSON.parse(value); } catch { throw new TypeError(`${where} must contain valid JSON`); }
}

// Strict persisted-event decode for the private-fact replay path (Finding 2,
// review round 4): delegates ENTIRELY to the SHARED log-row decoder — no local
// JSON.parse of persisted eventData remains. A v16 row's operated-handle
// identity is verified and duplicate-key/noncanonical/over-limit bytes fail
// closed before any projection runs. Non-v16 rows keep plain parsing.
function decodeCommittedEventJson(row: { eventType: unknown; eventData: unknown }): unknown {
  return decodeLogRowData(row as never);
}

interface ReceiptRow {
  scope: string;
  actionId: string;
  committedAt: string;
  eventRefs: string;
  actionType: string | null;
  historyOrder: number;
  principalKey: string | null;
  sessionId: string | null;
  operation: string;
  resultData: string | null;
  historyRootActionId: string | null;
  historyTargetActionId: string | null;
  historyOutcome: string | null;
}

interface PrivateFactRow {
  scope: string;
  actionId: string;
  committedAt: string;
  fact: string;
  effects: string;
  originOrder: number;
}

export interface CommittedEvent {
  type: string;
  scope: string;
  seq: number;
  actionId: string;
  committedAt: string;
  data: unknown;
}

export interface PostCommitProjection {
  eventTypes: string[];
  actionType?: string;
  /** Opt-in: this projection consumes the durable private fact and is safe to replay. */
  privateFact?: boolean;
  apply(committed: CommittedEvent, db: DbHandle, context: { privateFact: Record<string, unknown> }): void;
}

// Rebuild private projections solely from the private fact and its receipt-owned
// event references. The caller supplies only explicitly opted-in projections.
// One transaction covers the entire replay, and this seam performs no external I/O.
export function replayPrivateFactProjections(db: DbHandle, projections: PostCommitProjection[]): { projected: number } {
  const receipts = db.prepare('SELECT * FROM _ActionReceipt ORDER BY committedAt, scope, historyOrder').all() as unknown as ReceiptRow[];
  const facts = db.prepare('SELECT * FROM _PrivateActionFact ORDER BY originOrder').all() as unknown as PrivateFactRow[];
  const receiptsByAction = new Map(receipts.map((receipt) => [`${receipt.scope}\u0000${receipt.actionId}`, receipt]));
  const event = db.prepare('SELECT * FROM _Log WHERE scope = ? AND seq = ?');
  const validatedFacts = new Map<string, { row: PrivateFactRow; canonical: Record<string, unknown> }>();

  // Validate every private fact before filtering by the projections currently
  // registered in this process. Retired event types and effect-only actions are
  // still durable security-sensitive replay input and must fail closed.
  for (const row of facts) {
    const key = `${row.scope}\u0000${row.actionId}`;
    const owner = receiptsByAction.get(key);
    if (!owner || owner.committedAt !== row.committedAt) {
      throw new TypeError('private action fact does not match its action receipt');
    }
    const canonical = canonicalPrivateFact(parseJson(row.fact, 'private action fact'), true)!.fact;
    const refs = parseJson(owner.eventRefs, 'action receipt eventRefs');
    if (!Array.isArray(refs)) throw new TypeError('action receipt eventRefs must be an array');
    const seenRefs = new Set<string>();
    for (const ref of refs as Array<Record<string, unknown>>) {
      if (!ref || typeof ref.scope !== 'string' || !Number.isSafeInteger(ref.seq)) {
        throw new TypeError('action receipt contains a malformed event reference');
      }
      const refKey = `${ref.scope}\u0000${ref.seq}`;
      if (seenRefs.has(refKey)) throw new TypeError('action receipt contains a duplicate event reference');
      seenRefs.add(refKey);
      const stored = event.get(ref.scope, ref.seq);
      if (!stored) throw new TypeError('private action fact references a missing committed event');
      if (stored.actionId !== owner.actionId || stored.committedAt !== owner.committedAt) {
        throw new TypeError('private action fact does not match its referenced event');
      }
    }
    validatedFacts.set(key, Object.freeze({ row, canonical }));
  }

  let projected = 0;
  for (const owner of receipts) {
    const validated = validatedFacts.get(`${owner.scope}\u0000${owner.actionId}`);
    const row = validated?.row;
    const refs = parseJson(owner.eventRefs, 'action receipt eventRefs');
    if (!Array.isArray(refs)) throw new TypeError('action receipt eventRefs must be an array');
    const seenRefs = new Set<string>();
    for (const ref of refs as Array<Record<string, unknown>>) {
      if (!ref || typeof ref.scope !== 'string' || !Number.isSafeInteger(ref.seq)) {
        throw new TypeError('action receipt contains a malformed event reference');
      }
      const refKey = `${ref.scope}\u0000${ref.seq}`;
      if (seenRefs.has(refKey)) throw new TypeError('action receipt contains a duplicate event reference');
      seenRefs.add(refKey);
      const stored = event.get(ref.scope, ref.seq);
      // Unrelated receipts may legitimately outlive retained log rows. A
      // private fact, however, claims these refs as replay input and must match.
      if (!stored) {
        if (row) throw new TypeError('private action fact references a missing committed event');
        continue;
      }
      if (stored.actionId !== owner.actionId || stored.committedAt !== owner.committedAt) {
        throw new TypeError('action receipt does not match its referenced event');
      }
      const committed: CommittedEvent = Object.freeze({
        type: stored.eventType as string, scope: stored.scope as string, seq: stored.seq as number,
        actionId: stored.actionId as string, committedAt: stored.committedAt as string,
        // One strict log-row decoder (Finding 1): v16 rows are validated
        // before reaching private-fact projections; non-v16 rows keep the
        // same valid-JSON error boundary.
        data: decodeCommittedEventJson(stored as { eventType: unknown; eventData: unknown }),
      });
      // Only explicitly private-fact projections may be replayed here. Ordinary
      // entity projections already ran in the origin transaction; invoking them
      // again would double-apply their reducers on every replay.
      const matched = projections.filter((projection) =>
        projection.privateFact === true
        && projection.eventTypes.includes(committed.type)
        && (projection.actionType === undefined || projection.actionType === owner.actionType));
      if (matched.length === 0) continue;
      if (!row || row.committedAt !== owner.committedAt) {
        throw new TypeError('private-fact projection requires a matching durable private fact');
      }
      for (const projection of matched) {
        projection.apply(committed, db, Object.freeze({ privateFact: applicationPrivateFactView(validated!.canonical) }));
        projected += 1;
      }
    }
  }
  return { projected };
}

export interface PostCommitEffectId {
  scope: string;
  actionId: string;
  file: string;
  operation: string;
  ordinal: number;
}

export interface PostCommitEffectDescriptor {
  id: PostCommitEffectId;
  key: string;
  verification: string;
  payload: unknown;
  fence: number;
  leaseUntil: number | null;
}

function parse(row: Record<string, unknown> | null | undefined): PostCommitEffectDescriptor | null {
  if (!row) return null;
  return Object.freeze({
    id: Object.freeze({
      scope: row.scope as string, actionId: row.actionId as string, file: row.file as string, operation: row.operation as string, ordinal: row.ordinal as number,
    }),
    key: row.exclusionKey as string,
    verification: row.verification as string,
    payload: JSON.parse(row.payload as string),
    fence: row.fence as number,
    leaseUntil: row.leaseUntil as number | null,
  });
}

function identityWhere(): string {
  return 'scope = :scope AND actionId = :actionId AND file = :file AND operation = :operation AND ordinal = :ordinal';
}

function identityParams(id: unknown): Record<string, unknown> {
  if (!id || typeof id !== 'object') throw new TypeError('effect id is required');
  const record = id as PostCommitEffectId;
  return {
    scope: assertText(record.scope, 'effect id.scope'), actionId: assertText(record.actionId, 'effect id.actionId'),
    file: assertText(record.file, 'effect id.file'), operation: assertText(record.operation, 'effect id.operation'),
    ordinal: record.ordinal,
  };
}

// The runner is a synchronous driver seam. When the db has an attached write
// coordinator, a write that would interleave with a foreign in-flight
// transaction is deferred through that mutex and the method returns a Promise;
// a standalone or uncontended caller keeps the historical synchronous shape.
// `await` flattens both, exactly like the job-queue entry points.
type MaybeCoordinated<T> = T | Promise<T>;
type WriteCoordinatorLike = {
  run<T>(fn: () => T): Promise<T>;
  readonly owned?: boolean;
  readonly running?: boolean;
  readonly depth?: number;
  readonly closed?: boolean;
};

export interface PostCommitEffectRunner {
  claim(workerId: string): MaybeCoordinated<PostCommitEffectDescriptor | null>;
  heartbeat(id: PostCommitEffectId, workerId: string, fence: number): MaybeCoordinated<boolean>;
  complete(id: PostCommitEffectId, workerId: string, fence: number, options?: { verification?: string }): MaybeCoordinated<{ accepted: boolean; noop?: boolean; verification?: boolean }>;
  fail(id: PostCommitEffectId, workerId: string, fence: number, options?: { retryAt?: number }): MaybeCoordinated<{ accepted: boolean }>;
  reconstruct(): MaybeCoordinated<{ inserted: number }>;
}

export function createPostCommitEffectRunner({ db, leaseMs = 30_000, now = () => Date.now() }: {
  db?: DbHandle;
  leaseMs?: number;
  now?: () => number;
} = {}): PostCommitEffectRunner {
  if (!db) throw new Error('createPostCommitEffectRunner: db is required');
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError('leaseMs must be a positive safe integer');
  const handle = db;

  // Route a state-changing read/write through the one platform coordinator when
  // it is actually contended. Inside an owned turn we are already serialized;
  // with an idle mutex no other JS turn can interleave between these synchronous
  // driver statements. A contended turn must be deferred, otherwise the runner
  // write would land inside the kernel's still-open BEGIN IMMEDIATE.
  function coordinated<T>(fn: () => T): MaybeCoordinated<T> {
    // Resolve at call time: the app builds this runner before boot attaches the
    // kernel's coordinator to the db handle.
    const writeCoordinator: WriteCoordinatorLike | undefined =
      (handle as DbHandle & { writeCoordinator?: WriteCoordinatorLike }).writeCoordinator ?? writeQueueForDatabase(handle);
    if (!writeCoordinator) return fn();
    if (writeCoordinator.owned
      || (!writeCoordinator.running && !writeCoordinator.depth && !writeCoordinator.closed)) return fn();
    return writeCoordinator.run(fn);
  }

  function claim(workerId: string): MaybeCoordinated<PostCommitEffectDescriptor | null> {
    return coordinated(() => {
      assertText(workerId, 'workerId');
      const at = now();
      const row = handle.prepare(
        `UPDATE _PostCommitEffect
         SET status = ?, workerId = ?, leaseUntil = ?, fence = fence + 1
         WHERE declarationOrder = (
           SELECT candidate.declarationOrder FROM _PostCommitEffect candidate
           WHERE (candidate.status = ? OR (candidate.status = ? AND candidate.leaseUntil <= ?))
             AND (candidate.availableAt IS NULL OR candidate.availableAt <= ?)
             AND NOT EXISTS (
               SELECT 1 FROM _PostCommitEffect earlier
               WHERE earlier.exclusionKey = candidate.exclusionKey
                 AND (earlier.originOrder < candidate.originOrder
                   OR (earlier.originOrder = candidate.originOrder AND earlier.ordinal < candidate.ordinal))
                 AND earlier.status != ?
             )
           ORDER BY candidate.originOrder, candidate.ordinal LIMIT 1
         )
         RETURNING *`,
      ).get(STATUS_CLAIMED, workerId, at + leaseMs, STATUS_PENDING, STATUS_CLAIMED, at, at, STATUS_COMPLETED);
      return parse(row);
    });
  }

  function heartbeat(id: PostCommitEffectId, workerId: string, fence: number): MaybeCoordinated<boolean> {
    return coordinated(() => {
      const at = now();
      const params = { ...identityParams(id), workerId: assertText(workerId, 'workerId'), fence, at, leaseUntil: at + leaseMs };
      return handle.prepare(
        `UPDATE _PostCommitEffect SET leaseUntil = :leaseUntil
         WHERE ${identityWhere()} AND status = 'claimed' AND workerId = :workerId AND fence = :fence AND leaseUntil > :at`,
      ).run(params).changes > 0;
    });
  }

  function complete(id: PostCommitEffectId, workerId: string, fence: number, { verification }: { verification?: string } = {}): MaybeCoordinated<{ accepted: boolean; noop?: boolean; verification?: boolean }> {
    return coordinated(() => {
      const identity = identityParams(id);
      const current = handle.prepare(`SELECT status, workerId, fence, verification FROM _PostCommitEffect WHERE ${identityWhere()}`).get(identity);
      if (!current) return { accepted: false };
      if (verification !== current.verification) return { accepted: false, verification: false };
      if (current.status === STATUS_COMPLETED) {
        return current.workerId === workerId && current.fence === fence
          ? { accepted: true, noop: true }
          : { accepted: false };
      }
      const at = now();
      const params = { ...identity, workerId: assertText(workerId, 'workerId'), fence, at, completedAt: at, verification };
      const changed = handle.prepare(
        `UPDATE _PostCommitEffect SET status = 'completed', completedAt = :completedAt, leaseUntil = NULL
         WHERE ${identityWhere()} AND status = 'claimed' AND workerId = :workerId AND fence = :fence
           AND leaseUntil > :at AND verification = :verification`,
      ).run(params).changes;
      return changed > 0 ? { accepted: true, noop: false } : { accepted: false };
    });
  }

  function fail(id: PostCommitEffectId, workerId: string, fence: number, { retryAt = now() }: { retryAt?: number } = {}): MaybeCoordinated<{ accepted: boolean }> {
    return coordinated(() => {
      if (!Number.isFinite(retryAt)) throw new TypeError('retryAt must be a finite epoch time');
      const at = now();
      const params = { ...identityParams(id), workerId: assertText(workerId, 'workerId'), fence, at, retryAt };
      const changed = handle.prepare(
        `UPDATE _PostCommitEffect
         SET status = 'pending', workerId = NULL, leaseUntil = NULL, availableAt = :retryAt
         WHERE ${identityWhere()} AND status = 'claimed' AND workerId = :workerId AND fence = :fence AND leaseUntil > :at`,
      ).run(params).changes;
      return { accepted: changed > 0 };
    });
  }

  // Rebuild missing declarations from private canonical facts. Existing rows,
  // including completion/fence state, are never overwritten. This performs no I/O.
  function reconstruct(): MaybeCoordinated<{ inserted: number }> {
    return coordinated(() => {
      const facts = handle.prepare('SELECT * FROM _PrivateActionFact ORDER BY originOrder').all() as unknown as PrivateFactRow[];
      const insert = handle.prepare(
        `INSERT OR IGNORE INTO _PostCommitEffect
         (scope, actionId, file, operation, ordinal, originOrder, exclusionKey, verification, payload, declaredAt, status, fence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      );
      let inserted = 0;
      for (const fact of facts) {
        for (const effect of normalizeEffects(JSON.parse(fact.effects))) {
          inserted += Number(insert.run(fact.scope, fact.actionId, effect.file, effect.operation, effect.ordinal, fact.originOrder,
            effect.key, effect.verification, JSON.stringify(effect.payload), fact.committedAt).changes);
        }
      }
      return { inserted };
    });
  }

  return Object.freeze({ claim, heartbeat, complete, fail, reconstruct });
}
