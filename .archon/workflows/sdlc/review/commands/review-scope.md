# Review Scope

Establish exactly what this review round examines, and write it down for the lens reviewers. You do not judge anything — you make the target precise.

## Inputs

**Requested scope** (may be empty):

$INPUTS.scope

**Previous round's report** (path; empty on a first review):

$INPUTS.prior_report

The run's trigger message, which may narrow or override the above:

$ARGUMENTS

## Resolve the target

- A PR number, URL, or branch → resolve it with `gh pr view` (title, body, base, head, state, files) and `gh pr diff`. Make sure the PR's head is what the local checkout reflects; note the head SHA.
- Empty scope → the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch (`git merge-base`, `git diff`, `git log`). Note the current HEAD SHA.

## Light mode (a prior report exists)

Read the prior report. Extract its **reviewed-head cursor** (the SHA it records) and its findings list. This round's diff is **only the delta**: `git diff <cursor>..HEAD` plus any uncommitted changes. List each prior finding with its ID and status so lens reviewers verify those first instead of re-discovering the whole change.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing:

1. **Target** — PR reference or "working diff", base branch, and the **head SHA under review** (this becomes the next round's cursor).
2. **Mode** — full review, or light (delta since `<cursor>`).
3. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
4. **The diff to review** — inline when small; for a large diff, the exact commands a reviewer runs to see it (`git diff <range>`, `gh pr diff <n>`).
5. **Prior findings to verify** — light mode only: ID, severity, one-line claim, and the file it points at.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the head SHA, and that the diff commands in it actually produce output in this checkout. Reply with the target, mode, head SHA, and file count — nothing else.
