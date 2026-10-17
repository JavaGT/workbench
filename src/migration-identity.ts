// migration-identity.ts — the identity of one migration ledger row:
// `(namespace, version)`. The namespaced ledger's PRIMARY KEY is this pair, so
// two namespaces may share a version number and one namespace's versions are
// distinct rows.
//
// Both ends of that seam import this leaf rather than re-deriving it: the
// runner (`migration-ledger.ts`) keys applied rows by it, and the pre-touch
// census (`schema-census.ts`) claims a namespace once per schema while
// allowing several versions of it (consideration #12). The census is a pure
// declaration validator and must not reach the database driver, so the shared
// identity lives in this driver-free leaf.

/** Case-folds a migration namespace: `Scope` and `scope` are one namespace. */
export function foldedMigrationNamespace(namespace: string): string {
  return namespace.toLowerCase();
}

/**
 * The identity of one ledger row: the folded namespace plus its version, joined
 * by NUL so no namespace/version pair can collide with another pair.
 */
export function migrationIdentityKey(namespace: string, version: number): string {
  return `${foldedMigrationNamespace(namespace)}\u0000${version}`;
}
