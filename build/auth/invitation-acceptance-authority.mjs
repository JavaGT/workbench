import { collapseForAdmission, principal,                } from '../principal.mjs';
import { EventKind } from '../event-handle.mjs';























const invitationAcceptanceAuthorities = new WeakMap                                            ();

// A membership role is an authority, not a free-form string. Only a non-empty
// role the target entity actually declares in one of its membership maps may
// become an admission fact. An empty, non-string, or undeclared role fails
// closed instead of being echoed from the invitation row.
export function isDeclaredInvitationRole(
  role         ,
  declaredRoles                                       ,
)                 {
  return typeof role === 'string'
    && role.length > 0
    && Array.isArray(declaredRoles)
    && declaredRoles.includes(role);
}

// Mint the acceptance authority through the ONE principal constructor. A
// hand-rolled `{ type: 'user', id }` literal bypasses the closed type/status
// union and would let a revoked or malformed identity grant membership. Here
// the identity is rebuilt by principal() and collapsed at the admission seam:
// a non-active identity becomes anonymous and receives NO authority.
export function invitationAcceptancePrincipal(user                              )                   {
  if (!user || user.type !== 'user' || typeof user.id !== 'string' || user.id.length === 0) return null;
  const admitted = collapseForAdmission(principal({
    type: 'user',
    id: user.id,
    attributes: { ...user.attributes },
    status: user.status,
  }));
  if (admitted.type !== 'user' || admitted.id == null) return null;
  // A distinct frozen object keeps the WeakMap brand per authority, while
  // remaining a principal built by principal()/collapseForAdmission — never a
  // fabricated principal-shaped literal.
  const authority            = Object.freeze({ ...admitted });
  invitationAcceptanceAuthorities.set(authority, null);
  return authority;
}

// Store details ONLY when their role is declared on the target. `declaredRoles`
// comes from the load-time-validated field descriptor, never the request body;
// a self-declared role cannot smuggle an authority into the durable gate.
export function authorizeInvitationAcceptance(
  authority        ,
  details                             ,
  declaredRoles                   ,
)          {
  if (!isDeclaredInvitationRole(details.role, declaredRoles)) {
    invitationAcceptanceAuthorities.set(authority, null);
    return false;
  }
  invitationAcceptanceAuthorities.set(authority, Object.freeze(details)                               );
  return true;
}

export function admitInvitationAcceptance({ event, principal }                                                                            )          {
  const details = invitationAcceptanceAuthorities.get(principal);
  if (!details || !event?.handle) return false;
  const { handle, data } = event;
  if (
    handle.entity === details.targetEntity
    && handle.field === details.fieldName
    && handle.kind === EventKind.native
    && handle.nativeName === details.mapOperation
  ) {
    return String(data?.owner) === details.targetId
      && String(data?.member) === details.memberId
      && data?.role === details.role;
  }
  if (handle.entity !== 'Invitation' || String(data?.id) !== details.invitationId) return false;
  if (details.invitationOperation === 'update') {
    return handle.kind === EventKind.updated && data?.useCount === details.useCount;
  }
  return details.invitationOperation === 'remove' && handle.kind === EventKind.removed;
}

export function admitsInvitationRemoval(principal        , invitationId         )          {
  const details = invitationAcceptanceAuthorities.get(principal);
  return details?.invitationOperation === 'remove'
    && details.invitationId === String(invitationId);
}
