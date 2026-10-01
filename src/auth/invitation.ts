// Generic invitations are application-scoped. The bound Invitation facade is
// the authority for both the database and the entity registry, which prevents
// a caller from pairing an entity from one application with another database.

import { randomBytes } from 'node:crypto';
import { admin } from '../grant.ts';
import { readScopedRow } from '../http-crud-dispatch.ts';
import { rowCapabilities } from '../row-grant.ts';
import { MEMBER_COLUMN, membershipOwnerCol, membershipTable } from '../scope-sql.ts';
import { mapMutationAction } from '../side-table-strategy.ts';
import { failure } from '../outcome.ts';
import type { StatementLike } from '../http-crud-dispatch.ts';
import type { FieldDescriptor } from '../field-strategy.ts';
import type { WorkbenchFailure } from '../outcome.ts';
import type { Principal } from '../principal.ts';
import {
  authorizeInvitationAcceptance,
  invitationAcceptancePrincipal,
} from './invitation-acceptance-authority.ts';

export { admitInvitationAcceptance } from './invitation-acceptance-authority.ts';

// ---- Structural types --------------------------------------------------------
// The Invitation entity facade is bound at app construction (its `.runtime` is
// the application runtime), so these are the minimal shapes invitation.ts reads.
// The concrete driver and application runtime satisfy them structurally.

interface InvitationDb {
  prepare(sql: string): StatementLike;
}

interface InvitationTargetEntity {
  name: string;
  fields: Record<string, InvitationFieldDescriptor>;
  findById(id: unknown): unknown;
  deserializeRow(row: unknown): Record<string, unknown>;
  scopeFilter(principal: Principal): { sql: string; params: Record<string, unknown> };
  [key: string]: unknown;
}

interface InvitationFieldDescriptor extends FieldDescriptor {
  of?: { type?: string; target?: unknown };
  roles?: string[];
  access?: unknown;
}

interface InvitationRuntime {
  db?: InvitationDb;
  entityOf(target: unknown): InvitationTargetEntity;
  batch<T>(thunk: () => T, options?: { principal?: object }): Promise<InvitationBatchResult>;
}

interface InvitationBatchResult {
  ok: boolean;
  failure?: WorkbenchFailure;
  events: Array<{ type: string; data?: Record<string, unknown> | null }>;
}

// A stored/hydrated Invitation row as invitation.ts reads it: the declared
// fields from entities.ts (Invitation declaration), all loose enough for the
// facade to satisfy structurally.
interface InvitationRow {
  id: string;
  token: string;
  targetEntity: string;
  targetId: string;
  role: string;
  targetUser: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: number | null;
  createdAt: unknown;
  [key: string]: unknown;
}

interface InvitationFacade {
  name: string;
  runtime?: InvitationRuntime;
  token: { is(value: unknown): unknown };
  findOne(predicate: unknown): InvitationRow | null;
  findById(id: unknown): InvitationRow | null;
  hydrate(row: Record<string, unknown>): InvitationRow;
}

// The acceptance authority is declared in invitation-acceptance-authority.ts
// with `mapOperation: string` and `invitationOperation: 'update' | 'remove'`,
// but acceptance legitimately carries `null` for both (no map change / no
// invitation op). This is the runtime shape; the adapter below widens it at the
// authority boundary rather than changing the authority's declared type.
interface InvitationAcceptanceDetails {
  targetEntity: string;
  targetId: string;
  fieldName: string;
  role: string;
  memberId: string;
  mapOperation: string | null;
  invitationId: string;
  invitationOperation: 'update' | 'remove' | null;
  useCount: unknown;
}

interface CreateInvitationParams {
  targetEntity: unknown;
  targetId: unknown;
  role: unknown;
  targetUser?: unknown;
  maxUses?: unknown;
  expiresAt?: unknown;
  principal: Principal;
}

interface CreateInvitationApiOptions {
  Invitation?: InvitationFacade | null;
  db?: unknown;
}

export interface InvitationApi {
  createInvitation(params: CreateInvitationParams): Promise<InvitationRow>;
  acceptInvitation(token: string, user: Principal): Promise<{ targetEntity: string; targetId: string; role: string }>;
  rejectInvitation(token: string, user: Principal): Promise<void>;
  listInvitationsForUser(user: Principal): InvitationRow[];
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function requireSuccess(result: InvitationBatchResult | null | undefined, operation: string): void {
  if (!result?.ok) {
    throw { failure: result?.failure ?? failure('internal', `Invitation ${operation} failed.`) };
  }
}

const invitationCreationAuthorities = new WeakSet<object>();

function invitationCreationPrincipal(user: Principal): object {
  const authority = Object.freeze({
    type: 'user',
    id: user.id,
    attributes: Object.freeze({ ...(user.attributes ?? {}) }),
  });
  invitationCreationAuthorities.add(authority);
  return authority;
}

export function isInvitationCreationAuthority(principal: object | null | undefined): boolean {
  return principal != null && invitationCreationAuthorities.has(principal);
}

// The authority module's declared details type is stricter than the values
// acceptance really passes (mapOperation/invitationOperation may be null). The
// runtime shape is authoritative; widen at the boundary, never in the authority.
function authorizeAcceptance(authority: object, details: InvitationAcceptanceDetails): void {
  authorizeInvitationAcceptance(authority, details as unknown as Parameters<typeof authorizeInvitationAcceptance>[1]);
}

function invitationTargetFor(runtime: InvitationRuntime, name: string, role: string): {
  entity: InvitationTargetEntity;
  fieldName: string;
  table: string;
  ownerColumn: string;
} {
  let target: InvitationTargetEntity;
  try {
    target = runtime.entityOf(name);
  } catch {
    throw httpError(400, `unknown invitation target entity '${name}'`);
  }

  const roleCandidates = Object.entries(target.fields).filter(([, descriptor]) =>
    descriptor?.kind === 'store'
    && descriptor.type === 'map'
    && descriptor.of?.type === 'ref'
    && Array.isArray(descriptor.roles)
    && descriptor.roles.includes(role));
  const candidates = roleCandidates.filter(([, descriptor]) => {
    try {
      return runtime.entityOf(descriptor.of!.target).name === 'User';
    } catch {
      return false;
    }
  });
  if (candidates.length !== 1) {
    throw httpError(
      400,
      candidates.length === 0 && roleCandidates.length > 0
        ? `invitation role '${role}' on ${target.name} must be a map of User references`
        : candidates.length === 0
        ? `role '${role}' is not an invitation role on ${target.name}`
        : `role '${role}' is ambiguous on ${target.name}`,
    );
  }
  const [fieldName] = candidates[0];
  return {
    entity: target,
    fieldName,
    table: membershipTable(target.name, fieldName),
    ownerColumn: membershipOwnerCol(target.name),
  };
}

export async function admitInvitationCreation({ Invitation, event, principal }: {
  Invitation?: InvitationFacade | null;
  event?: { data?: Record<string, unknown> | null } | null;
  principal: Principal;
}): Promise<boolean> {
  if (!isInvitationCreationAuthority(principal)) return false;
  const runtime = Invitation?.runtime;
  const invitation = event?.data;
  if (!runtime?.db || !invitation || String(invitation.createdBy) !== String(principal.id)) {
    return false;
  }

  const target = invitationTargetFor(runtime, String(invitation.targetEntity), String(invitation.role));
  const storedRow = readScopedRow({ db: runtime.db }, target.entity, String(invitation.targetId), principal);
  if (!storedRow) throw httpError(404, `${target.entity.name} ${String(invitation.targetId)} not found`);
  const row = target.entity.deserializeRow({ ...storedRow });
  const decision = await rowCapabilities(target.entity, row, principal);
  return decision.granted && decision.capabilities.includes(admin);
}

export function createInvitationApi({ Invitation, db: suppliedDb }: CreateInvitationApiOptions = {}): InvitationApi {
  const runtime = Invitation?.runtime;
  if (!Invitation || !runtime?.db || typeof runtime.entityOf !== 'function' || typeof runtime.batch !== 'function') {
    throw new Error('createInvitationApi requires an application-bound Invitation entity');
  }
  if (suppliedDb && suppliedDb !== runtime.db) {
    throw new Error('Invitation and db must belong to the same application runtime');
  }
  // Bind the narrowed facade and runtime to consts so the nested functions below
  // (which are not narrowed across their declaration boundary) see them typed.
  const boundInvitation: InvitationFacade = Invitation;
  const appRuntime: InvitationRuntime = runtime;
  // The guard above already proved `runtime.db` is present; the explicit
  // annotation on `appRuntime` widens the narrowed binding back, so assert.
  const db = appRuntime.db!;

  function targetFor(name: string, role: string) {
    return invitationTargetFor(appRuntime, name, role);
  }

  async function createInvitation({
    targetEntity, targetId, role, targetUser, maxUses, expiresAt, principal,
  }: CreateInvitationParams): Promise<InvitationRow> {
    if (!targetEntity || !targetId || !role || !principal?.id) {
      throw httpError(400, 'createInvitation requires targetEntity, targetId, role, and principal');
    }
    if (principal.type !== 'user') {
      throw httpError(403, 'a user principal is required to create an invitation');
    }
    if (maxUses != null && (!Number.isInteger(maxUses) || (maxUses as number) < 1)) {
      throw httpError(400, 'maxUses must be a positive integer');
    }

    const authority = invitationCreationPrincipal(principal);
    const result = await appRuntime.batch(() => [{
      type: `${boundInvitation.name}.create`,
      payload: {
        token: randomBytes(32).toString('base64url'),
        targetEntity,
        targetId,
        role,
        ...(targetUser == null ? {} : { targetUser }),
        ...(maxUses == null ? {} : { maxUses }),
        useCount: 0,
        ...(expiresAt == null ? {} : { expiresAt }),
        createdBy: principal.id,
        createdAt: Date.now(),
      },
    }], { principal: authority });
    requireSuccess(result, 'creation');

    const created = result.events.find((event) => event.type === `${boundInvitation.name}.created`);
    const invitation = created?.data?.id == null
      ? null
      : boundInvitation.findById(String(created.data.id));
    if (!invitation) throw httpError(500, 'invitation creation did not produce a stored invitation');
    return invitation;
  }

  async function acceptInvitation(token: string, user: Principal): Promise<{ targetEntity: string; targetId: string; role: string }> {
    if (!token || !user?.id) {
      throw httpError(400, 'acceptInvitation requires a token and a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to accept an invitation');
    }

    let accepted: { targetEntity: string; targetId: string; role: string } | null = null;
    const authority = invitationAcceptancePrincipal(user);
    const result = await appRuntime.batch(() => {
      const invitation = boundInvitation.findOne(boundInvitation.token.is(token));
      if (!invitation) throw httpError(404, 'invitation not found');
      if (invitation.expiresAt !== null && Date.now() >= invitation.expiresAt) {
        throw httpError(400, 'invitation has expired');
      }
      if (invitation.targetUser !== null && String(invitation.targetUser) !== String(user.id)) {
        throw httpError(403, 'this invitation is for a different user');
      }

      // Resolve the stored name through the application registry before it can
      // influence an identifier. Only load-time validated declarations supply
      // the table and column names used below.
      const target = targetFor(invitation.targetEntity, invitation.role);
      if (!target.entity.findById(invitation.targetId)) {
        throw httpError(404, `${target.entity.name} ${invitation.targetId} not found`);
      }

      const actions = [];
      try {
        const existing = db.prepare(
          `SELECT role FROM ${target.table} WHERE ${target.ownerColumn} = :owner AND ${MEMBER_COLUMN} = :member`,
        ).get({ owner: invitation.targetId, member: user.id });
        const membershipChanged = !existing || existing.role !== invitation.role;

        if (
          membershipChanged
          && invitation.targetUser === null
          && invitation.maxUses !== null
          && invitation.useCount >= invitation.maxUses
        ) {
          throw httpError(400, 'invitation has reached its maximum uses');
        }

        // An exact-role replay is idempotent and does not exhaust a public link.
        // Applying a different role is a new grant, so it consumes a use and
        // cannot pass an exhausted invitation.
        if (membershipChanged) {
          actions.push(mapMutationAction({
            entityName: target.entity.name,
            fieldName: target.fieldName,
            operation: existing ? 'setRole' : 'add',
            owner: invitation.targetId,
            member: user.id,
            role: invitation.role,
          }));
        }

        if (membershipChanged) {
          if (invitation.targetUser === null) {
            actions.push({
              type: 'Invitation.update',
              payload: { id: invitation.id, useCount: invitation.useCount + 1 },
            });
          }
        }
        if (invitation.targetUser !== null) {
          actions.push({ type: 'Invitation.remove', payload: { id: invitation.id } });
        }
        authorizeAcceptance(authority, {
          targetEntity: target.entity.name,
          targetId: String(invitation.targetId),
          fieldName: target.fieldName,
          role: invitation.role,
          memberId: String(user.id),
          mapOperation: membershipChanged ? (existing ? 'roleChanged' : 'added') : null,
          invitationId: String(invitation.id),
          invitationOperation: invitation.targetUser !== null ? 'remove' : membershipChanged ? 'update' : null,
          useCount: invitation.useCount + 1,
        });
      } catch (error) {
        const e = error as { status?: unknown; message?: string };
        if (e.status) throw error;
        throw httpError(500, `failed to grant membership on ${target.entity.name}: ${e.message}`);
      }

      accepted = {
        targetEntity: target.entity.name,
        targetId: invitation.targetId,
        role: invitation.role,
      };
      return actions;
    }, { principal: authority });
    requireSuccess(result, 'acceptance');
    return accepted!;
  }

  async function rejectInvitation(token: string, user: Principal): Promise<void> {
    if (!token || !user?.id) {
      throw httpError(400, 'rejectInvitation requires a token and a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to reject an invitation');
    }
    const authority = invitationAcceptancePrincipal(user);
    const result = await appRuntime.batch(() => {
      const invitation = boundInvitation.findOne(boundInvitation.token.is(token));
      if (!invitation) throw httpError(404, 'invitation not found');
      if (invitation.targetUser === null) {
        throw httpError(400, 'cannot reject an open link invitation');
      }
      if (String(invitation.targetUser) !== String(user.id)) {
        throw httpError(403, 'this invitation is for a different user');
      }
      const target = targetFor(invitation.targetEntity, invitation.role);
      authorizeAcceptance(authority, {
        targetEntity: target.entity.name,
        targetId: String(invitation.targetId),
        fieldName: target.fieldName,
        role: invitation.role,
        memberId: String(user.id),
        mapOperation: null,
        invitationId: String(invitation.id),
        invitationOperation: 'remove',
        useCount: invitation.useCount,
      });
      return [{ type: 'Invitation.remove', payload: { id: invitation.id } }];
    }, { principal: authority });
    requireSuccess(result, 'rejection');
  }

  function listInvitationsForUser(user: Principal): InvitationRow[] {
    if (!user?.id) {
      throw httpError(400, 'listInvitationsForUser requires a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to list invitations');
    }
    const rows = db.prepare(`
      SELECT * FROM Invitation AS t0
      WHERE t0.targetUser = :userId
        AND (t0.expiresAt IS NULL OR t0.expiresAt > :now)
      ORDER BY t0.createdAt DESC
    `).all({ userId: user.id, now: Date.now() });
    return rows.map((row) => boundInvitation.hydrate(row));
  }

  return { createInvitation, acceptInvitation, rejectInvitation, listInvitationsForUser };
}
