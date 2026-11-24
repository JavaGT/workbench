// Recipient-safe annotated-text fold envelopes for live delivery (issue #33
// blockless model).
//
// The server emits BLOCKLESS state: one continuous RGA family per document.
// This projector emits a single v5 fold envelope for a contiguous whole-document
// text.apply / text.replace transition when the recipient's view of the ENTIRE
// document is fully visible and unredacted. The fully-visible client folds the
// text operations onto its own family copy (seeded from its snapshot's authoring
// envelope) and verifies the resulting text, so the server never re-ships a
// whole snapshot per keystroke. Restricted or any-way redacted recipients never
// fold — they stay on snapshot recovery because they can neither seed nor
// verify a fold. Annotation edits change no text and fall through to the
// ordinary envelope grammar; block-era operation shapes fall through with them.
//
// v5 is the fold that pairs with recipient envelope v2 (anchored ranges).
// Earlier fold versions fail closed to snapshot recovery on a version mismatch
// so a client never misreads endpoints as offsets or silently prunes an
// emptied orphan.

import { parseEventType, EventKind } from './event-handle.ts';
import { evaluateAnnotatedTextVisibility } from './annotated-text-snapshot.ts';
import {
  restoreTextFamilySerialized,
  textFamilyBasis,
  textFamilyElementCount,
  materializeText,
  type ContinuousTextFamily,
} from './annotated-text-continuous.ts';
import { frontierDominates } from './annotated-text.ts';
import {
  ensureStream,
  ensureLease,
  hashClientNonce,
  issueAuthoringSnapshot,
  buildAuthoringEnvelope,
  readAnnotatedTextFamilyCheckpoint,
} from './annotated-text-authoring-stream.ts';
import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.ts';
import type { Principal } from './principal.ts';
import type { FieldDescriptor } from './field-strategy.ts';
import type { LiveEntityRecord } from './live-fanout.ts';
import { rawRow } from './entity/query.ts';

interface FoldStatement {
  run(...args: unknown[]): { changes: number };
  get(...args: unknown[]): any;
  all(...args: unknown[]): any[];
}

interface FoldDb {
  prepare(sql: string): FoldStatement;
  exec(sql: string): unknown;
}

interface FoldDocument {
  entity: LiveEntityRecord;
  documentId: string;
  fieldName: string;
  descriptor: FieldDescriptor | null | undefined;
  clientNonce?: string | null;
}

interface FoldEvent {
  data?: OperatedData | null;
  eventType?: string;
  type?: string;
  scope?: string;
  seq: number;
  committedAt?: string;
  actionId?: string | number | null;
}

interface FoldCtx {
  event: FoldEvent;
  principal: Principal | null | undefined;
  scope: string;
}

interface OperatedFacts {
  family: any;
  [key: string]: unknown;
}

interface OperatedData {
  version: 14;
  id: string;
  before: { structuralRevision: number; frontier: any };
  after: { structuralRevision: number; frontier: any };
  facts: OperatedFacts;
  operation: any;
}

interface FoldAuthoring {
  version: 1;
  stream: string;
  lease: string;
  snapshot: string;
  acknowledgementFence: number;
  positionFrames: Array<{ positionToken: string }>;
}

// The plan's authoritative emptied-annotation disposition (mirrors
// annotated-text-plan.ts EmptiedAnnotation): an annotation whose range an edit
// collapsed to zero width is either `deleted` (dropped) or `orphaned` (kept
// with its saved quote), per its declaration's `empty` policy. The fold carries
// only the disclosure the recipient is entitled to.
interface EmptiedDisposition {
  annotationId: string;
  empty: 'delete' | 'orphan';
  disposition:
    | { kind: 'orphaned'; family: string; savedQuote: string; lastRange: number[] | null }
    | { kind: 'deleted'; family: string; savedQuote: string | null; lastRange: number[] | null };
}

interface FoldDisposition {
  annotationId: string;
  kind: 'deleted' | 'orphaned';
  family: string;
  savedQuote?: string;
}

// The v14 operated-event facts bag is one exact key set (mirrors
// annotated-text-operated-facts.mjs and the row projection). Anything else —
// including a block-era facts bag — fails closed and falls through.
const OPERATED_FACTS_KEYS = ['actorId', 'annotation', 'annotationUpdates', 'emptiedAnnotations', 'family', 'lifecycle', 'measurements', 'ranges', 'removedAnnotationIds', 'result', 'selectedRange'];

function recovery(ctx: FoldCtx, entity: string, id: string, reason: string): object[] {
  return [{ type: 'resync', entity, id, seq: ctx.event.seq, reason }];
}

function exactKeys(value: any, keys: readonly string[]): boolean {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function revision(value: any): boolean {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === 'frontier,structuralRevision'
    && Number.isSafeInteger(value.structuralRevision) && value.structuralRevision >= 1
    && Array.isArray(value.frontier);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// A foldable edit is a whole-document text transition only. `operations` is
// always an array of RGA ops applied in sequence: one op for text.apply, the
// delete+insert pair for text.replace.
function foldableTextEdit(operation: any): { kind: 'text.apply' | 'text.replace'; operations: any[] } | null {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return null;
  if (operation.kind === 'text.apply' && Array.isArray(operation.operation)) {
    return { kind: 'text.apply', operations: [operation.operation] };
  }
  if (operation.kind === 'text.replace'
    && Array.isArray(operation.operations)
    && operation.operations.length === 2
    && operation.operations.every((candidate: unknown) => Array.isArray(candidate))) {
    return { kind: 'text.replace', operations: operation.operations };
  }
  return null;
}

function opsWellFormed(operations: any[], beforeFrontier: unknown): boolean {
  if (!Array.isArray(operations) || operations.length === 0) return false;
  for (const operation of operations) {
    if (!Array.isArray(operation) || operation.length !== 6
      || operation[0] !== 'workbench.text' || operation[1] !== 1
      || !Array.isArray(operation[4])) {
      return false;
    }
  }
  // The fold applies against the client's PRE-commit copy, so the first
  // operation must name exactly the pre-commit frontier as its basis.
  return JSON.stringify(operations[0][4]) === JSON.stringify(beforeFrontier);
}

function scopeParts(scope: unknown): { entity: string | null; id: string | null } {
  if (typeof scope !== 'string') return { entity: null, id: null };
  const idx = scope.indexOf(':');
  if (idx <= 0) return { entity: null, id: null };
  return { entity: scope.slice(0, idx), id: scope.slice(idx + 1) };
}

/**
 * Build a single recipient-authorized annotated-text fold envelope, or null when
 * this projector should fall through to the ordinary envelope grammar.
 *
 * @returns {Promise<object[]|null>}
 */
export async function tryBuildAnnotatedTextFoldEnvelopes(ctx: FoldCtx, { db, document }: { db: FoldDb; document: FoldDocument }): Promise<object[] | null> {
  if (!document || document.descriptor?.kind !== 'annotatedText') return null;
  const event = ctx.event;
  const data = event?.data;
  // Retired v13/v15 never reached the committed log (the operated-event gate
  // admits only v14/v16), so v13 is rejected here fail-closed rather than folded.
  if (!data || data.version !== 14 || data.id !== document.documentId) return null;

  let evHandle;
  try {
    evHandle = parseEventType((event.eventType ?? event.type) as string);
  } catch {
    return null;
  }
  if (evHandle.kind !== EventKind.native
    || evHandle.nativeName !== 'operated'
    || evHandle.entity !== document.entity.name
    || evHandle.field !== document.fieldName) {
    return null;
  }

  // The operated envelope is one exact shape; anything else (including block-era
  // operated envelopes) falls through to the ordinary envelope grammar.
  if (!exactKeys(data, ['after', 'before', 'facts', 'id', 'operation', 'version'])
    || !revision(data.before) || !revision(data.after)
    || !exactKeys(data.facts, OPERATED_FACTS_KEYS)) {
    return null;
  }
  const facts = data.facts;
  // v14 carries no canonical family in its facts bag; the fold verifies against
  // the family restored from the committed checkpoint instead.
  if (facts.family !== null) return null;

  // Only contiguous whole-document text edits fold. annotation.apply-range and
  // annotation.remove change no text (before.frontier === after.frontier) and
  // fall through to the ordinary envelope grammar, which delivers a snapshot/
  // resync so the client's annotation view stays correct. Block-era operation
  // kinds fall through and are rejected with them.
  const foldable = foldableTextEdit(data.operation);
  if (!foldable) return null;

  const { entity: scopeEntity, id: scopeId } = scopeParts(ctx.scope);
  const entityName = scopeEntity ?? document.entity.name;
  const id = scopeId ?? document.documentId;

  // Edited-word field patches (Decision 0025 policy 4) do not fold: the fold
  // envelope carries text operations plus delete/orphan dispositions only. An
  // edit that patches annotation fields falls back to snapshot recovery so the
  // recipient's annotation view stays correct.
  const annotationUpdates = (facts as any).annotationUpdates;
  if (Array.isArray(annotationUpdates) && annotationUpdates.length > 0) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const row = rawRow(db, document.entity.name, document.documentId);
  if (!row) return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');

  const prefix = `${document.entity.name}_${document.fieldName}`;
  let committed;
  try {
    const familyCheckpoint = readAnnotatedTextFamilyCheckpoint(db, prefix, document.documentId);
    if (familyCheckpoint === undefined) return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
    committed = restoreTextFamilySerialized(familyCheckpoint);
  } catch {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  // Fast-path fully-visible live fold (#292): evaluate ONLY protecting
  // annotations for this principal instead of running full
  // projectAnnotatedTextSnapshot (which would load and project all unrelated
  // annotations on every keystroke per recipient).
  let visibility;
  try {
    visibility = await evaluateAnnotatedTextVisibility({
      db,
      entity: document.entity,
      row,
      principal: ctx.principal,
      fieldName: document.fieldName,
      descriptor: document.descriptor,
      family: committed,
    });
  } catch {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  // A fold is only safe for a recipient that reads the ENTIRE document
  // unredacted: it must be able to verify every transition it folds against its
  // own family copy, and its authoring position frame binds the canonical
  // family. Restricted or any-way redacted recipients never receive a family
  // seed, so they stay on snapshot recovery (fail closed).
  if (!visibility.fullyVisible || visibility.restricted || visibility.redactions.length > 0) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  // Carry the authoritative emptied-annotation disposition through the fold so
  // the recipient's one reconciliation path reproduces the server's delete-vs-
  // orphan decision instead of inferring it. This gate has already proved the
  // recipient sees the ENTIRE document unredacted, so an orphaned annotation's
  // historical saved quote discloses nothing the recipient could not already
  // read.
  const emptiedAnnotations = (facts.emptiedAnnotations ?? []) as Array<EmptiedDisposition>;
  if (!Array.isArray(emptiedAnnotations)) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }
  const compiled = getAnnotatedTextCompiledMetadata(document.descriptor);
  let disclosures: FoldDisposition[];
  try {
    if (emptiedAnnotations.some((emptied) =>
      compiled && Object.hasOwn(compiled.protectingFamilies, emptied?.disposition?.family))) {
      return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
    }
    disclosures = [];
    for (const emptied of emptiedAnnotations) {
      if (!emptied || typeof emptied !== 'object' || Array.isArray(emptied)
        || typeof emptied.annotationId !== 'string'
        || !emptied.disposition || typeof emptied.disposition !== 'object' || Array.isArray(emptied.disposition)
        || (emptied.disposition.kind !== 'deleted' && emptied.disposition.kind !== 'orphaned')
        || typeof emptied.disposition.family !== 'string'
        || (emptied.disposition.kind === 'orphaned' && typeof emptied.disposition.savedQuote !== 'string')) {
        return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
      }
      // Defense in depth: protecting-family dispositions never leave the server
      // even if a future gate change re-enables folding an emptied protector.
      if (compiled && Object.hasOwn(compiled.protectingFamilies, emptied.disposition.family)) continue;
      disclosures.push(Object.freeze({
        annotationId: emptied.annotationId,
        kind: emptied.disposition.kind,
        family: emptied.disposition.family,
        ...(emptied.disposition.kind === 'orphaned' ? { savedQuote: emptied.disposition.savedQuote } : {}),
      }));
    }
  } catch {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  // Verify the fold against the committed family. Since this recipient is
  // proven fully visible, its projected text equals `materializeText(committed)`.
  let committedText: string;
  try {
    if (JSON.stringify(committed.checkpoint.frontier) !== JSON.stringify(data.after.frontier)
      || JSON.stringify(committed.checkpoint.frontier) === JSON.stringify(data.before.frontier)
      || !frontierDominates(committed.checkpoint.frontier, data.before.frontier)
      || !opsWellFormed(foldable.operations, data.before.frontier)) {
      return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
    }
    committedText = materializeText(committed);
  } catch {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const fence = event.seq;
  const baseCursor = fence - 1;
  if (!Number.isSafeInteger(baseCursor) || baseCursor < 0) {
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const authoring = mintFoldAuthoring({
    db,
    document,
    principal: ctx.principal,
    fence,
    family: committed,
  });
  if (!authoring) {
    // Without a refreshed authoring envelope the client cannot name a fresh
    // position frame against the post-commit family; it must snapshot-recover.
    return recovery(ctx, entityName, id, 'annotated-text-snapshot-required');
  }

  const loggedEvent: { type: string | undefined; scope: string | undefined; seq: number; committedAt: string | undefined; actionId?: string | number } = {
    type: event.eventType ?? event.type,
    scope: event.scope,
    seq: event.seq,
    committedAt: event.committedAt,
  };
  if (event.actionId !== undefined && event.actionId !== null) loggedEvent.actionId = event.actionId;

  const fold = Object.freeze({
    kind: 'annotatedText',
    version: 5,
    field: document.fieldName,
    baseCursor,
    fence,
    text: Object.freeze({
      reducer: 'workbench.text',
      operations: Object.freeze(foldable.operations.map((operation) => deepFreeze(structuredClone(operation)))),
    }),
    projection: Object.freeze({
      text: committedText,
    }),
    // The authoritative emptied-annotation disposition (deleted vs orphaned)
    // this transition committed, restricted to annotations the recipient's
    // snapshot actually discloses. The client fold consumes these; a range the
    // projection emptied without a disposition fails closed to recovery.
    dispositions: Object.freeze(disclosures),
    // Compact cross-check the client can verify against its own post-apply
    // family without serializing the whole checkpoint.
    familyElementCount: textFamilyElementCount(committed),
    authoring: Object.freeze({
      acknowledgementFence: fence,
      stream: authoring.stream,
      lease: authoring.lease,
      snapshot: authoring.snapshot,
      positionFrames: Object.freeze((authoring.positionFrames ?? []).map((frame) => Object.freeze({
        positionToken: frame.positionToken,
      }))),
    }),
  });

  return [Object.freeze({
    type: 'event',
    entity: entityName,
    id,
    seq: event.seq,
    seqSpan: Object.freeze([event.seq, event.seq]),
    event: Object.freeze(loggedEvent),
    fold,
  })];
}

/**
 * Mint the authoring envelope a fold ships. One DOCUMENT-scoped position frame
 * binds the whole post-commit family basis: the fully-visible recipient seeds
 * its fold reducer from that same family, so its next absolute offset resolves
 * against this exact checkpoint. Redactions are empty here by construction (the
 * caller gates redacted recipients before minting). Returns null when the
 * client nonce is missing or authoring capacity is exhausted.
 */
function mintFoldAuthoring({ db, document, principal, fence, family }: {
  db: FoldDb;
  document: FoldDocument;
  principal: Principal | null | undefined;
  fence: number;
  family: ContinuousTextFamily;
}): FoldAuthoring | null {
  const prefix = `${document.entity.name}_${document.fieldName}`;
  if (typeof document.clientNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(document.clientNonce)) {
    return null;
  }
  const stream = ensureStream({
    db,
    prefix,
    documentId: document.documentId,
    principalType: principal?.type ?? 'principal',
    principalId: principal?.id ?? '',
  });
  const lease = ensureLease({
    db,
    prefix,
    streamId: stream.id,
    clientNonceHash: hashClientNonce(document.clientNonce),
  });
  if (!lease) return null;

  const issued = issueAuthoringSnapshot({
    db,
    prefix,
    leaseId: lease.id,
    fence,
    positions: [{
      familyCheckpoint: textFamilyBasis(family),
      visibleAtIssue: true,
      redactions: [],
    }],
  });
  if (!issued) return null;
  return buildAuthoringEnvelope({
    streamToken: stream.id,
    leaseToken: lease.id,
    snapshotToken: issued.snapshot.id,
    fence,
    positionFrames: issued.positionFrames,
  });
}
