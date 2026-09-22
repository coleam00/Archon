# Review Scope

Establish exactly what this review round examines, and write it down for the reviewer or reviewers that follow. You do not judge anything; you make the target precise.

## Inputs

**Requested scope** (may be empty):

$INPUTS.scope

**Previous round's report** (path; empty means this is the first round, full review):

$INPUTS.prior_report

**Accepted work order** (may be empty for a standalone review):

$INPUTS.work_order

The run's trigger message, which may narrow or override the above:

$ARGUMENTS

## Resolve the target

- When the requested scope is a qualified PR record, review exactly that PR. Read it with forge `pr.view` using the recorded repository and number, and use an adaptable read tool for its diff. Do not resolve another target from the current branch.
- A PR number, URL, or branch → resolve its repository through forge `resolve`, then read the exact target through `pr.view` by qualified number or head selector. Use an available read-only forge tool for the PR diff, or the equivalent pinned local git range when the checkout has both revisions. Make sure the PR's head is what the local checkout reflects; note the head SHA. **In PR mode the review object is the PR's diff, exactly — uncommitted or untracked local state is out of scope and must not appear in the scope file.**
- Empty scope → resolve the origin repository and query `pr.view` with the qualified current-head selector. If it returns a PR, that PR is the target (PR mode, as above). Otherwise review the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch (`git merge-base`, `git diff`, `git log`). Note the current HEAD SHA.

## Resolve the accepted contract

- When `work_order` is non-empty, read it in full. It is the accepted contract implementation received. Preserve its required outcome, explicit non-goals, and boundaries as prose; do not parse it with scripts, regexes, or keyword extraction.
- When `work_order` is empty and the target is a PR, use the PR body's problem/outcome and explicit scope or non-goals as the standalone review contract. Do not infer a broader promise from the changed files.
- When neither supplies an explicit boundary, state that the review is using the requested scope and repository contracts without inventing a non-goal.

## Select docs review

Set `docs` true when the reviewed diff changes shipped documentation, unless the
diff is small, mechanical, and likely-correct — a version bump, a one-line fix, a
rename, a test-only tweak — in which case a doc-adjacent touch alone does not
earn the lens. Otherwise set it false. This selection applies only when the
workflow's `docs` input is `auto`; an explicit input overrides it.

## Light mode (a prior report exists)

When a prior-report path is supplied, require that it exists and read it in full. A missing supplied report is a broken continuation contract: fail with the path named instead of silently starting a full review. Extract its **reviewed-head cursor** (the SHA it records). For a PR target, this round's diff is **only the delta**: `git diff <cursor>..HEAD`. For a working-diff target, include that delta plus any uncommitted changes. The prior report remains the sole owner of earlier findings and review coverage; do not copy or rebuild them in scope.md.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing:

1. **Accepted contract** — the required outcome, followed by explicit non-goals or boundaries. State the source: supplied work order, PR body, or requested scope/repository contracts.
2. **Target** — PR reference or "working diff", base branch, and the **head SHA under review** (this becomes the next round's cursor).
3. **Mode** — full review, or light (delta since `<cursor>`).
4. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
5. **The diff to review** — inline when small; for a large diff, the exact qualified read or pinned `git diff <range>` command a reviewer uses to reproduce it.
6. **Prior report** — continuation mode only: its path and reviewed-head cursor. Do not duplicate its findings or coverage.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the accepted contract and head SHA, and that the diff commands in it actually produce output in this checkout. Return `docs` and `pr`: the complete schema-owned PR record in PR mode, or `{}` for a working diff.
