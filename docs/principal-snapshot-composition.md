# Principal snapshot composition

A principal snapshot is a read-only, server-projected view of host-owned data,
anchored to one `Principal` (type + id). The machinery is the Decision-0019
bridge: a generic runtime cannot observe host SQL, so the host (1) declares a
projection, (2) invalidates it inside its own transactions, and (3) supplies a
membership-aware reauthorization seam. The runtime owns projection, cursor,
reconnect, and revocation; the host owns when a recipient's view changes and
whether a recipient may still see it.

This page composes every piece end to end: declaration registration, the
transaction mutation pattern, the principal resolver, the reauthorization
adapter, and the client session wiring.

## 1. Declare the projection (server)

A declaration names a principal type and a set of `many` collections projected
from one table, filtered by a `via` column that holds the principal id.

```ts
import { projectionSource, principalSnapshot } from 'workbench';

const schema = app.schema; // the frozen application schema object

const hubItems = projectionSource(schema, 'HubItem');

const userHub = principalSnapshot('user-hub', {
  principalType: 'user',
  output: principalSnapshot.object({
    items: principalSnapshot.many(hubItems, {
      via: hubItems.field.recipientId,          // WHERE recipientId = <principal.id>
      key: hubItems.field.id,
      select: principalSnapshot.select(hubItems.field.title),
      orderBy: [principalSnapshot.orderBy(hubItems.field.rank)],
    }),
  }),
});
```

Registration happens when you attach live delivery (section 2). The runtime
validates the declaration against the application schema: every projected
table and column must exist, and every field handle must come from the declared
source. Only declared columns are ever projected — an undeclared sensitive
column never leaves the server.

### 1b. Physical tables and joining display columns

A hub's authoritative tables are not always schema-declarable (single-owner /
entity-owned / framework-grant tables, and the display columns on a related
root). Two extensions cover a real hub without weakening the read-only,
recipient-anchored, declared-column guarantee:

- **Physical sources** project a host table the app owns but cannot declare in
  the schema. The host names the table and every column it will project; the
  runtime validates the declaration against that explicit list and the field
  proxy exposes ONLY declared columns (fail closed):

  ```ts
  const memberSource = projectionSourcePhysical('Project_members', ['Project_id', 'member_id', 'role']);
  ```

- **Joins** denormalize related display columns onto an anchored collection
  without a second delivery authority. `on.from` is an FK column on the ANCHOR
  table, `on.to` and `join.select` are on the JOINED table. Rows carry the
  anchor's selected columns and the joined columns, namespaced by their table:

  ```ts
  const projectSource = projectionSourcePhysical('Project', ['id', 'name', 'colour', 'iconUpdatedAt']);

  const memberships = principalSnapshot.many(memberSource, {
    via: memberSource.field.member_id,          // WHERE member_id = <principal.id>
    key: memberSource.field.Project_id,
    select: principalSnapshot.select(memberSource.field.Project_id, memberSource.field.role),
    join: {
      source: projectSource,
      on: { from: memberSource.field.Project_id, to: projectSource.field.id },
      select: principalSnapshot.select(projectSource.field.name, projectSource.field.colour),
    },
  });
  // rows: { Project_members__Project_id, Project_members__role, Project__name, Project__colour }
  ```

  The projection is still strictly per-recipient (`via = principal.id` on the
  anchor), so the join never widens visibility beyond the anchored rows.

### 1c. Filter rows with typed server-side checks

Use the snapshot filter grammar when a recipient may see only some of their
anchored rows. It accepts field handles, fixed string allowlists, and one
principal-correlated `exists` relation; it does not accept SQL text or callbacks.
The runtime validates every referenced source and column, quotes identifiers,
and binds principal and allowlist values as SQL parameters. The principal anchor
always remains an `AND` term outside the fully parenthesized filter.

```ts
const membershipSource = projectionSourcePhysical('Project_members', ['Project_id', 'member_id', 'role']);
const notifications = principalSnapshot.many(notificationSource, {
  via: notificationSource.field.userId,
  key: notificationSource.field.id,
  select: principalSnapshot.select(notificationSource.field.id, notificationSource.field.projectId),
  where: principalSnapshot.filter.or(
    principalSnapshot.filter.isNull(notificationSource.field.projectId),
    principalSnapshot.filter.exists(membershipSource, principalSnapshot.filter.and(
      principalSnapshot.filter.equal(membershipSource.field.Project_id, notificationSource.field.projectId),
      principalSnapshot.filter.equal(membershipSource.field.member_id, principalSnapshot.principal.id),
      principalSnapshot.filter.in(membershipSource.field.role, ['editor', 'owner']),
    )),
  ),
});
```

The explicit allowlist excludes legacy and malformed role values. `exists`
filters project-scoped rows without dropping personal rows (`projectId IS NULL`)
and checks both the same principal and the same project. Filters run inside the
shared projection path, so bootstrap, catchup, subscription setup, and resync
all materialize the same authorized rows. Because a filter change can tighten
visibility without changing a recipient's data revision, filtered declarations
return a replacement snapshot on every catchup, even when the cursor is current.
This costs one full filtered projection on filtered-client reconnect/catchup, but
prevents a client holding a pre-deployment snapshot from retaining rows removed
by a new policy. Filterless declarations keep the empty-current-cursor shortcut.


## 2. Attach delivery (server)

The application seam is `app.attachLiveDelivery(options)`. It registers your
declarations, wires the wake hook to the delivery, and mounts `/bootstrap` and
`/events` routes (and the WebSocket upgrade) at `options.path`.

```ts
import type { Principal } from 'workbench';

app.attachLiveDelivery({
  principalOf: async (req) => sessionPrincipalOf(req), // request -> Principal (type + id)
  principalSnapshots: [userHub],
  // Host membership/authorization for snapshots — see section 4.
  principalSnapshotAuthorize: ({ declaration, principal, trigger }) => {
    return membershipAllows(principal, declaration); // host policy
  },
  // Optional: the same authorization adapter used for entity delivery.
  authorization,
});
```

Every access to a principal snapshot fails closed if `principalSnapshotAuthorize`
is omitted (a deployment MUST supply it) or if it returns anything other than
strictly `true`.

## 3. Mutate host state, then invalidate (server)

Host mutations go through the app transaction seam so the durable invalidation
lands in the SAME SQLite transaction as the host mutation. Rollback undoes
both; commit survives restart; duplicate invalidations coalesce.

```ts
await app.principalSnapshots.transaction((tx) => {
  // 1. Ordinary host-owned mutation — any SQL, any table.
  db.prepare('UPDATE HubItem SET title = ? WHERE id = ?').run('Renamed', 'a');
  // 2. Bump the recipient's snapshot revision inside the same transaction.
  tx.invalidate(userHub, { type: 'user', id: 'u1' });
});
```

The callback is synchronous — no awaits, no returned promises. The transaction
refuses nested `transaction()` calls, unregistered or foreign declarations, and
`invalidate` after the callback returns. Only the `_PrincipalSnapshotRevision`
row and `tx.db` are touched: no `_Log` rows, receipts, or committed revisions
are written, so the wake is not a second collaborative mutation authority.

After commit, the runtime wakes the attached delivery, which reauthorizes
(section 4) and delivers a `resync` envelope to open subscriptions for that
recipient.

## 4. The reauthorization adapter (server)

`PrincipalSnapshotAuthorize` is the ONLY host authority over whether a recipient
may receive a snapshot. Scope-level admission (declaration name + principal type
+ exact principal id from the scope string) is a grammar gate, not an
authorization gate — a revoked membership does not change the grammar.

```ts
type PrincipalSnapshotAuthorize =
  (input: {
    declaration: PrincipalSnapshotDeclaration;
    principal: { type: string; id: string };
    trigger: 'bootstrap' | 'catchup' | 'subscribe' | 'resync';
  }) => boolean | Promise<boolean>;
```

The runtime invokes it **before every recipient projection**:

- `bootstrap` — one-shot initial snapshot (`GET /live-delivery/bootstrap`)
- `catchup` — stale-cursor recovery (`mode=catchup`)
- `subscribe` — SSE / WebSocket subscription admission (`GET /live-delivery/events`)
- `resync` — every replacement/resync drain on a long-lived subscription

A denial, an authorizer error, or a non-`true` result fails closed:

- bootstrap / catchup return `{ kind: 'revoked' }`;
- subscription admission revokes the transport first, then rejects with the
  terminal `live-delivery-revoked` code (the HTTP skin maps it to HTTP 403);
- a **resync drain** revokes the subscription **before** any replacement
  projection is delivered — a principal whose membership was revoked never
  receives another row.

A membership-aware implementation (what Scope supplies) checks the host's own
tables inside the trigger callback — e.g. a live `Membership` row keyed by
recipient:

```ts
const membershipAllows = ({ declaration, principal }) => {
  const row = db.prepare(
    'SELECT 1 FROM Member WHERE hub = ? AND memberId = ? AND active = 1',
  ).get(declaration.name, principal.id);
  return row !== undefined;
};
```

`resync` runs on every drain, so a long-lived connection is re-checked whenever
a replacement is about to be delivered — the HTTP layer's one-time principal
resolution per request is not the authorization boundary.

## 5. Client session (browser)

The client uses `createPrincipalSnapshotHttpSession` from `workbench/client`.
It owns the scope string, cursor, reconnect, and opaque-resync replacement; it
exposes no mutation, reducer, or cursor-configuration seam.

```js
import { createPrincipalSnapshotHttpSession } from 'workbench/client';

const session = createPrincipalSnapshotHttpSession({
  baseUrl: '/live-delivery',
  declaration: 'user-hub',
  principal: { type: 'user', id: 'u1' },
  validateSnapshot(value) {
    // Reject a malformed payload from the server before it reaches state.
    if (!value || !Array.isArray(value.items)) throw new Error('invalid snapshot');
    return value;
  },
});

await session.ready;
console.log(session.snapshot.items); // recipient-only rows, already validated

session.subscribe((snapshot) => renderHub(snapshot));
// session.reconnect(); session.close();  // lifecycle as needed
```

## End-to-end flow

```
host mutation ──> app.principalSnapshots.transaction ──> [_PrincipalSnapshotRevision +1, same txn]
                                                            │ commit
                                                            v
                                          wake hook → delivery.wake(decl, principal)
                                                            │
                                        subscription drain (long-lived) ──> reauthorize
                                                            │
                                          admitted  ──> resync envelope ──> client re-bootstrap
                                          denied    ──> revoke (stream ends) — nothing delivered
```

One-shot reads (`bootstrap`/`catchup`) run the same reauthorization before any
projection; denials surface as `revoked` — the HTTP skin returns the explicit
revoked JSON result for the one-shot request (bootstrap/catchup), and for a
long-lived subscription ends the stream. A one-shot denial is not an HTTP 403;
it is the same `{ kind: 'revoked' }` envelope the transport uses.

## Files

- `src/principal-snapshot-declaration.ts` — declaration grammar, `projectionSource`
- `src/principal-snapshot-scope.ts` — `PrincipalSnapshot:<declaration>/<type>/<id>` scope grammar
- `src/principal-snapshot-transaction.ts` — transaction-bound atomic invalidation
- `src/principal-snapshot-delivery.ts` — bootstrap/catchup/subscribe/resync/revoke,
  the `PrincipalSnapshotAuthorize` seam
- `src/live-delivery-public.ts`, `src/application-live-delivery.ts` — app integration
- `public/workbench-client.mjs` — `createPrincipalSnapshotHttpSession`
