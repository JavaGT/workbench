# Issue Tracker: GitHub

Issues and specs for this repository live as GitHub issues. Use the `gh` CLI for all operations.

Implementation work is authored in a Workbench lane. Read [`lane-delivery.md`](./lane-delivery.md) before creating a lane or handing off a branch.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with relevant label filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** External pull requests are not included in routine issue triage.

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket,
read the issue body, comments, labels, dependencies, and assignee.

## Wayfinding operations

Use one GitHub issue as the map and child issues as tickets. Record blockers with GitHub issue dependencies
when available; otherwise add `Blocked by: #<n>` to the child body. Use the `epic` label for maps.
