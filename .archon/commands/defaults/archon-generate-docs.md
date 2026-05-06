---
description: Update user-facing documentation (CHANGELOG fragment, README, docs/) to reflect the changes on the current branch.
argument-hint: (none - reads task context and current diff)
---

Your task is to update user-facing documentation to reflect the changes
on this branch.

Inputs:
- `git diff origin/main` — the source changes that need to be
  documented.
- `$ARTIFACTS_DIR/task-context.md` — the task summary, description, and
  acceptance criteria. Use it to understand the user-visible intent of
  the changes (not just what files moved).
- `$decode.output.issue_key` — the Jira key to reference in the
  CHANGELOG entry.

Output:
- Always create `.changelog/<issue-key>.md` (lowercase issue key,
  e.g. `.changelog/wor-42.md`). Each ticket gets its own fragment
  file — never edit the project's `CHANGELOG.md` directly. A
  release-time script concatenates fragments at version-bump time;
  per-ticket fragments avoid the merge conflicts that would
  otherwise hit every parallel branch trying to add an entry to
  the same shared file.
  Format: a short markdown block with a heading line referencing
  the issue key and a 1–3 sentence description of what shipped
  for users.
- Update `README.md` only if the changes affect how a user/developer
  sets up or uses the project (new commands, env vars, dependencies,
  setup steps).
- Update or add entries under `docs/**/*.md` for any
  feature/setting/concept the diff introduces.

Constraint: write only `.changelog/<issue-key>.md`, `README.md`,
and `docs/**/*.md`. Do not edit `CHANGELOG.md`. Do not touch
source, tests, or package files.

Commit only the docs files you touched.

