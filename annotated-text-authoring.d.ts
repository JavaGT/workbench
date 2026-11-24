// Type definitions for workbench/annotated-text-authoring — the server-side
// authoring seam: stream/lease/position-frame minting plus the blockless
// continuous-family primitives a server needs to issue an authoring binding
// without importing the browser client SDK (workbench/client).
//
// Source of truth: build/annotated-text-authoring-public.mjs (a re-export
// aggregator over src/annotated-text-authoring-stream.ts and
// src/annotated-text-continuous.ts).
// Projection for TypeScript app authors. JS users see no change.

export interface AuthoringStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface AuthoringDatabase {
  /** @deprecated Use Workbench-owned accessors instead of issuing schema SQL directly. */
  prepare(sql: string): AuthoringStatement;
  exec(sql: string): unknown;
}

/** One issued binding: a stream, a lease, and the document-scoped position
 *  frame that anchors a v9 annotated-text operation. The caller supplies the
 *  mutation id at dispatch time; this helper never mints one. */
export interface IssueAuthoringBindingOptions {
  readonly db: AuthoringDatabase;
  readonly entity: {
    readonly name: string;
    readonly fields?: Readonly<Record<string, { readonly kind?: unknown; readonly [property: string]: unknown }>>;
    readonly [property: string]: unknown;
  };
  readonly row: { readonly id: string; readonly [property: string]: unknown };
  readonly principal?: {
    readonly type?: string;
    readonly id?: string | null;
  } | null;
  readonly fieldName: string;
  /** Defaults to `entity.fields[fieldName]` when omitted. */
  readonly descriptor?: { readonly kind?: unknown; readonly [property: string]: unknown } | null;
}

export interface IssuedAuthoringBindingSnapshot {
  readonly authoring: {
    readonly version: 1;
    readonly stream: string;
    readonly lease: string;
    readonly snapshot: string;
    readonly acknowledgementFence: number;
    readonly positionFrames: readonly { readonly positionToken: string }[];
  };
  readonly [property: string]: unknown;
}

export interface IssuedAuthoringBinding {
  readonly streamToken: string;
  readonly leaseToken: string;
  readonly leaseId: string;
  readonly snapshot: IssuedAuthoringBindingSnapshot;
  readonly documentPositionToken: string;
}

export function issueAuthoringBinding(options: IssueAuthoringBindingOptions): Promise<IssuedAuthoringBinding>;

export interface AuthoringPositionInput {
  readonly familyCheckpoint: unknown;
  readonly visibleAtIssue?: boolean;
  readonly redactions?: readonly unknown[];
}

export interface AuthoringSnapshot {
  readonly id: string;
  readonly fence: number;
}

export function hashClientNonce(nonce: string): string;

export function ensureStream(options: {
  readonly db: AuthoringDatabase;
  readonly prefix: string;
  readonly documentId: string;
  readonly principalType: string;
  readonly principalId: string;
}): { id: string; created: boolean };

export function ensureLease(options: {
  readonly db: AuthoringDatabase;
  readonly prefix: string;
  readonly streamId: string;
  readonly clientNonceHash: string;
}): { id: string; created: boolean; acknowledgedFence: number } | null;

export function issueAuthoringSnapshot(options: {
  readonly db: AuthoringDatabase;
  readonly prefix: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly positions: ReadonlyArray<AuthoringPositionInput>;
}): { positionFrames: ReadonlyArray<{ token: string }>; snapshot: AuthoringSnapshot } | null;

export function buildAuthoringEnvelope(options: {
  readonly streamToken: string;
  readonly leaseToken: string;
  readonly snapshotToken: string;
  readonly fence: number;
  readonly positionFrames: ReadonlyArray<{ token: string }>;
}): {
  readonly version: 1;
  readonly stream: string;
  readonly lease: string;
  readonly snapshot: string;
  readonly acknowledgementFence: number;
  readonly positionFrames: ReadonlyArray<{ positionToken: string }>;
};

export function acknowledgeAndPruneSnapshot(options: {
  readonly db: AuthoringDatabase;
  readonly prefix: string;
  readonly snapshotId: string;
  readonly leaseId: string;
}): { fence: number; alreadyAcknowledged: boolean } | null;

export function readAnnotatedTextFamilyCheckpoint(
  db: AuthoringDatabase,
  prefix: string,
  documentId: string,
): string | undefined;

export function readProjectedCursorFence(
  db: AuthoringDatabase,
  entity: string,
  field: string,
): number | undefined;

// The blockless continuous-family primitives (issue #33). A family is an
// opaque document checkpoint: consumers obtain one from
// `restoreTextFamilySerialized` and hand it straight back to the other two
// primitives — its internal RGA checkpoint shape is not part of this seam.

export type AuthoringOpId = readonly [actor: string, counter: number];
export type AuthoringFrontier = readonly AuthoringOpId[];
export type AuthoringAnchor =
  | readonly ['root']
  | readonly ['element', readonly [op: AuthoringOpId, ordinal: number]];
export type AuthoringStructuralPoint = readonly ['point', AuthoringAnchor, 'left' | 'right'];

export interface AuthoringStructuralEndpoint {
  readonly point: AuthoringStructuralPoint;
  readonly basisFrontier: AuthoringFrontier;
}

export interface ContinuousTextFamily {
  readonly id: string;
  readonly checkpoint: unknown;
}

export function restoreTextFamilySerialized(serialized: unknown): ContinuousTextFamily;

export function textFamilyBasis(family: ContinuousTextFamily): {
  readonly version: 1;
  readonly id: string;
  readonly frontier: AuthoringFrontier;
};

export function projectEndpointToOffset(family: ContinuousTextFamily, endpoint: AuthoringStructuralEndpoint): number;
