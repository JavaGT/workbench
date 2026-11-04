// Shared helpers used across multiple side-table strategy implementations.
//
// These live in their own module so the per-strategy modules (map/log/ordered/
// ephemeral) can import them without importing the strategy barrel — that
// back-edge was the cycle: strategy/index.mjs imported the strategy modules
// while they imported their shared helpers back from it.

import { randomUUID } from 'node:crypto';

import type { Capability } from '../grant.ts';
import { mayFieldOp } from '../row-grant.ts';
import type { EntityRecord } from '../row-grant.ts';
import type { AuthorizationAdapter } from '../authorization-adapter.ts';
import type { Principal } from '../principal.ts';
import { failure } from '../outcome.ts';

// The generic field-denial reason code from the A2 adapter's closed vocabulary
// (S5/A3). A rejected field write carries this code; the production HTTP failure
// stays category 'denied' → 403 with the generic 'forbidden' message — never the
// field name, so an attacker cannot distinguish a protected field from a missing
// one.
const FIELD_ACCESS_DENIED_REASON = 'no-field-access';

// The 403 a denied field write raises. Carries the generic reason code (never a
// field name) and a WorkbenchFailure so HTTP dispatch maps it to
// failure('denied', 'forbidden') without echoing anything app-specific.
function deniedFieldError(reasonCode: string): Error & { status: number; failure: unknown; reasonCode: string } {
  const error = new Error('forbidden') as Error & { status: number; failure: unknown; reasonCode: string };
  error.status = 403;
  error.failure = failure('denied', 'forbidden');
  error.reasonCode = reasonCode;
  return error;
}

export async function authorizeFieldOp(record: unknown, fieldName: string, capability: string, row: unknown, principal: unknown, authorization: AuthorizationAdapter | null = null): Promise<void> {
  if (!principal) return;
  if (authorization) {
    const decision = await authorization.admit({
      category: 'entity',
      verb: 'update',
      operation: 'update',
      principal: principal as Principal,
      entity: record as EntityRecord,
      row,
      fieldName,
      capability: capability as unknown as Capability,
      resourceId: rowIdOf(row),
    });
    if (!decision.admitted) throw deniedFieldError(decision.reasonCode ?? FIELD_ACCESS_DENIED_REASON);
    return;
  }
  if (!(await mayFieldOp(record as EntityRecord, fieldName, capability as unknown as Capability, row, principal))) {
    throw deniedFieldError(FIELD_ACCESS_DENIED_REASON);
  }
}

function rowIdOf(row: unknown): string | null {
  const id = (row as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

export function requireFieldDispatch(entityName: string, fieldName: string, dispatch: unknown): void {
  if (!dispatch) {
    throw new Error(
      `cannot mutate ${entityName}.${fieldName} without a dispatch ref ` +
        `(hydrate with dispatch inside a handler/route)`,
    );
  }
}

interface DispatchInput {
  actionId: string;
  type: string;
  payload: unknown;
  principal?: unknown;
}

interface DispatchResult {
  ok: boolean;
  failure?: unknown;
}

// The shared tail of every side-table write: require a dispatch ref, dispatch
// the field action, fail closed on deny. Callers authorize BEFORE their
// payload prep so an unauthorized principal gets 403 even when the write would
// be a no-op. Returns the dispatch result for handles that read emitted events.
export async function dispatchFieldMutation({ entityName, fieldName, dispatch, type, payload, principal }: {
  entityName: string;
  fieldName: string;
  dispatch: (input: DispatchInput) => Promise<DispatchResult>;
  type: string;
  payload: unknown;
  principal?: unknown;
}): Promise<DispatchResult> {
  requireFieldDispatch(entityName, fieldName, dispatch);
  const result = await dispatch({ actionId: randomUUID(), type, payload, principal });
  if (!result.ok) throw { failure: result.failure };
  return result;
}

export interface MapMutationPayload {
  owner: string;
  member: string;
  role?: unknown;
}

export function mapMutationAction({ entityName, fieldName, operation, owner, member, role }: {
  entityName: string;
  fieldName: string;
  operation: string;
  owner: unknown;
  member: unknown;
  role?: unknown;
}): Readonly<{ type: string; payload: Readonly<MapMutationPayload> }> {
  if (!['add', 'setRole', 'remove'].includes(operation)) {
    throw new Error(`unknown map mutation operation '${String(operation)}'`);
  }
  const payload: MapMutationPayload = { owner: String(owner), member: String(member) };
  if (operation !== 'remove') payload.role = role ?? null;
  return Object.freeze({
    type: `${entityName}.${fieldName}.${operation}`,
    payload: Object.freeze(payload),
  });
}
