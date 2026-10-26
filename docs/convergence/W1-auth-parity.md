# W1 — Auth parity

**Goal:** workbench owns identity end-to-end for its apps, grown to Scope parity
and beyond, so Scope's better-auth can be retired at end state.

## Binding rulings (DECISIONLOG 2026-07-06, not re-litigable)

- Every auth layer ships **sensible defaults + deep developer customisation**.
- **Sessions, passkeys, and the two-plane pattern** must be expressible:
  org/group membership = management visibility, **never** data access; data
  access = explicit per-project (per-resource) grant. This lands as a
  **generic grant/check pattern**, not a Scope feature.
- Fail closed everywhere (AGENTS.md); no second auth path — new surfaces route
  through the existing check registry / grant engine.
- Zero runtime dependencies. WebAuthn/TOTP are implemented on `node:crypto`
  or they are escalated to the owner — never solved with an npm package.

## Current workbench state (verified 2026-07-06)

- `src/auth/session.mjs`, `src/auth/entities.mjs`, `src/auth/routes.mjs`,
  `src/principal.mjs` — sessions + principal union (SPEC §6.2, `anonymous`
  first-class).
- `src/grant.mjs`, `src/row-grant.mjs`, `src/check.mjs`, `src/authz.mjs` —
  the two-face check registry (SQL scope + runtime boolean), inherit chains
  proven to 3 hops (`test/multi-hop-inherit.test.mjs`).
- Two-plane already *provable* with membership maps + `inherit`
  (`test/project-membership-inherit.test.mjs`) — but it is a test pattern, not
  yet a named, documented, defaulted pattern.
- `src/rate-limit.mjs`; job-queue bearer tokens (`src/job-queue.mjs`) as the
  existing API-key-like mechanism.

## Password write policy (#7672)

An app that owns a password policy passes `minimumPasswordLength` to
`.auth()`. Workbench applies that floor to registration and password changes;
login continues to verify the stored credential without reapplying a write
rule. The host passes its policy value so its registration and recovery paths
use the same boundary.

## Scope parity surface (from `~/Development/scope/prisma/schema.prisma` + `src/server/handlers/auth.ts`)

Prisma auth models: `User, Session, Account, Verification, Passkey, TwoFactor,
Organization, OrganizationMember, Invite, ProjectMember, ProjectInvitation,
ProjectApiKey`.

## Stage 0 — census (Flash, read-only, parallel-safe)

Produce `docs/convergence/census/W1-auth.md`: a table with one row per auth
feature **Scope actually uses** (grep better-auth config in
`src/server/index.ts`, `src/server/handlers/auth.ts`, client-side auth calls,
and each Prisma auth model's real read/write sites — not what better-auth
merely offers). Columns: feature · Scope evidence (file:line) · workbench
equivalent today · gap class (`exists / thin-wrap / build / defer-candidate`).
Explicitly answer: does Scope use OAuth/social login at all? Email
verification/reset flows? What do `Invite` vs `ProjectInvitation` each do?

## Expected design decisions (council items)

1. **Passkey ceremony split** — which parts of WebAuthn registration/assertion
   live in workbench (challenge issue/verify, credential storage as auth
   entities) vs the app (UI). Constraint: `node:crypto` only.
2. **Two-plane as a named pattern** — proposed shape: a documented
   `membership(...)`-style declaration + SPEC section + exemplar, built from
   existing map fields + inherit; no new engine. Council reviews the naming and
   the default.
3. **TOTP/2FA** — build now vs defer (depends on census: does Scope enforce it
   or merely enable it?).
4. **Email-delivery seam** — verification/reset emails are out-of-band effects
   (post-commit projections, AGENTS.md); workbench ships the flow + a
   pluggable transport, never an SMTP client.

**Owner escalations:** OAuth build-vs-defer (if census finds real usage);
whether Scope users must re-login at cutover (session migration).

## Slices (sequence after census; each behind full `node --test` green)

1. Named two-plane pattern + SPEC §6 subsection + exemplar in a `projects/*`
   app (this is mostly concentration of what exists).
2. Passkeys: credential entities, register/assert routes, challenge lifecycle;
   acceptance test drives a full ceremony with a synthetic authenticator.
3. Invitations as a generic flow (invite → accept → grant), covering both of
   Scope's invite shapes if the census shows they differ.
4. API keys: generalise the job-queue bearer pattern into a first-class
   principal kind if the census shows `ProjectApiKey` needs it.
5. TOTP (if ruled in), email-flow seam.

## Done criteria

- Census table has no `build` rows left un-actioned (each is shipped, deferred
  by owner ruling, or redesigned away).
- A `projects/*` app authenticates with sessions + passkeys and demonstrates
  two-plane (manager sees the project card, cannot read its data) in an
  acceptance test.
- Every default is overridable; the override seam is tested, not just present.

## Contention

Owns: `auth/entities.mjs, auth/routes.mjs, auth/session.mjs, principal.mjs,
rate-limit.mjs`. Coordinate with W2 only on `ddl.mjs` (new auth tables) and
with everyone on the barrels (`index.mjs, internal.mjs, index.d.ts`) —
coordinator resolves barrel conflicts at merge.
