// Generic invitations are application-scoped. The bound Invitation facade is
// the authority for both the database and the entity registry, which prevents
// a caller from pairing an entity from one application with another database.

import { randomBytes } from 'node:crypto';
import { admin } from '../grant.mjs';
import { readScopedRow } from '../http-crud-dispatch.mjs';
import { rowCapabilities } from '../row-grant.mjs';
import { MEMBER_COLUMN, membershipOwnerCol, membershipTable } from '../scope-sql.mjs';
import { mapMutationAction } from '../side-table-strategy.mjs';
import { failure } from '../outcome.mjs';




import {
  authorizeInvitationAcceptance,
  invitationAcceptancePrincipal,
} from './invitation-acceptance-authority.mjs';

export { admitInvitationAcceptance } from './invitation-acceptance-authority.mjs';

// ---- Structural types --------------------------------------------------------
// The Invitation entity facade is bound at app construction (its `.runtime` is
// the application runtime), so these are the minimal shapes invitation.ts reads.
// The concrete driver and application runtime satisfy them structurally.
































// A stored/hydrated Invitation row as invitation.ts reads it: the declared
// fields from entities.ts (Invitation declaration), all loose enough for the
// facade to satisfy structurally.























// The acceptance authority is declared in invitation-acceptance-authority.ts
// with `mapOperation: string` and `invitationOperation: 'update' | 'remove'`,
// but acceptance legitimately carries `null` for both (no map change / no
// invitation op). This is the runtime shape; the adapter below widens it at the
// authority boundary rather than changing the authority's declared type.


































function httpError(status        , message        )                             {
  return Object.assign(new Error(message), { status });
}

function requireSuccess(result                                          , operation        )       {
  if (!result?.ok) {
    throw { failure: result?.failure ?? failure('internal', `Invitation ${operation} failed.`) };
  }
}

const invitationCreationAuthorities = new WeakSet        ();

function invitationCreationPrincipal(user           )         {
  const authority = Object.freeze({
    type: 'user',
    id: user.id,
    attributes: Object.freeze({ ...(user.attributes ?? {}) }),
  });
  invitationCreationAuthorities.add(authority);
  return authority;
}

export function isInvitationCreationAuthority(principal                           )          {
  return principal != null && invitationCreationAuthorities.has(principal);
}

// The authority module's declared details type is stricter than the values
// acceptance really passes (mapOperation/invitationOperation may be null). The
// runtime shape is authoritative; widen at the boundary, never in the authority.
function authorizeAcceptance(authority        , details                             )       {
  authorizeInvitationAcceptance(authority, details                                                                  );
}

function invitationTargetFor(runtime                   , name        , role        )




  {
  let target                        ;
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
      return runtime.entityOf(descriptor.of .target).name === 'User';
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

export async function admitInvitationCreation({ Invitation, event, principal }



 )                   {
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

export function createInvitationApi({ Invitation, db: suppliedDb }                             = {})                {
  const runtime = Invitation?.runtime;
  if (!Invitation || !runtime?.db || typeof runtime.entityOf !== 'function' || typeof runtime.batch !== 'function') {
    throw new Error('createInvitationApi requires an application-bound Invitation entity');
  }
  if (suppliedDb && suppliedDb !== runtime.db) {
    throw new Error('Invitation and db must belong to the same application runtime');
  }
  // Bind the narrowed facade and runtime to consts so the nested functions below
  // (which are not narrowed across their declaration boundary) see them typed.
  const boundInvitation                   = Invitation;
  const appRuntime                    = runtime;
  // The guard above already proved `runtime.db` is present; the explicit
  // annotation on `appRuntime` widens the narrowed binding back, so assert.
  const db = appRuntime.db ;

  function targetFor(name        , role        ) {
    return invitationTargetFor(appRuntime, name, role);
  }

  async function createInvitation({
    targetEntity, targetId, role, targetUser, maxUses, expiresAt, principal,
  }                        )                         {
    if (!targetEntity || !targetId || !role || !principal?.id) {
      throw httpError(400, 'createInvitation requires targetEntity, targetId, role, and principal');
    }
    if (principal.type !== 'user') {
      throw httpError(403, 'a user principal is required to create an invitation');
    }
    if (maxUses != null && (!Number.isInteger(maxUses) || (maxUses          ) < 1)) {
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

  async function acceptInvitation(token        , user           )                                                                    {
    if (!token || !user?.id) {
      throw httpError(400, 'acceptInvitation requires a token and a user with an id');
    }
    if (user.type !== 'user') {
      throw httpError(403, 'a user principal is required to accept an invitation');
    }

    let accepted                                                                  = null;
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
        const e = error                                          ;
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
    return accepted ;
  }

  async function rejectInvitation(token        , user           )                {
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

  function listInvitationsForUser(user           )                  {
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
