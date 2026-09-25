# Workbench lane delivery

Workbench development is lane-first. The canonical checkout is for reading, gates, and
integration; source writes happen in a managed lane worktree.

## Create a lane

From the Workbench repository:

```bash
pnpm lanes create <name> --owns <path>... [--base origin/main] [--no-install]
```

The default lane root is `~/Development/workbench-lanes`. Override it only when a
machine-specific layout is required:

```bash
WORKBENCH_LANES_ROOT=~/Development/workbench-lanes pnpm lanes status
```

`--owns` takes literal repository-relative files or directory prefixes. Globs,
absolute paths, and `..` are rejected. A lane refuses creation when its paths
overlap another active lane, so split ownership before starting parallel work.
The lane records its base, branch, worktree, creation time, and expiry in both a
local manifest and `refs/lanes/<name>`.

## Work and commit

- Edit and commit only inside the lane worktree.
- Commit every meaningful milestone; uncommitted work is not part of the lane receipt.
- Never reset, stash, clean, or overwrite the canonical checkout or another lane.
- Keep generated `build/**/*.mjs` output synchronized with authored `src/**/*.ts` through
  `pnpm build`; do not hand-edit emitted files.
- Use `pnpm lanes status` before dispatching another writer. Stale, missing, dirty, or
  badly drifted lanes are reported there.

Useful checks while developing:

```bash
pnpm build                         # when src changes
node --test test/<focused>.test.mjs
pnpm lint
pnpm typecheck
```

Run the full `pnpm test` only for a wave-close or release decision. A lane does not
run shared development servers or paid hosted CI. Local checks and the commit SHA
are the evidence for the handoff.

## Extend ownership

If the committed work legitimately needs another path, record the expansion before closing:

```bash
pnpm lanes extend <name> --owns <path>...
```

The command rejects globs, unknown paths, and overlaps with another active lane. `close` compares the lane's committed diff with its declared paths and refuses out-of-scope commits, so a receipt cannot hide scope creep.

## Integrate

A lane branch is an integration queue item, not a silent merge:

1. Push `lane/<name>` to the configured remote.
2. Open a draft pull request for normal review, or use an owner-authorized manual
   fast-forward when hosted checks are unavailable.
3. For a manual local-only integration, use a commit message containing `[skip ci]`
   and never force-push `main`.
4. Verify the exact integrated SHA and rerun the focused check before closing the lane.

The lane command deliberately has no `merge` subcommand. It cannot overwrite a
foreign dirty checkout or turn an unreviewed branch into `main` by accident.

## Close a lane

After the branch is integrated or deliberately abandoned:

```bash
pnpm lanes close <name> --reason "one-line receipt"
```

Close refuses a dirty worktree, archives the head at `refs/archive/lane/<name>`,
removes the local worktree and branch, and preserves the manifest receipt. A remote
branch is left untouched so the integrator can clean it up explicitly.

## Cross-repository changes

Scope and Workbench have separate lane registries. A Scope lane never owns a path
in `~/Development/workbench`. For a change that spans both repositories:

1. create and verify a Workbench lane for the Workbench-owned paths;
2. publish its immutable commit;
3. create a Scope lane for the Scope pin or adapter;
4. verify Scope against that exact Workbench commit.

This order keeps the package source and the consumer pin independently reviewable.
