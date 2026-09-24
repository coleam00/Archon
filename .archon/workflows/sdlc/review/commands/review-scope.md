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

- When the requested scope is a recorded pull request — delivery passes its verified record as JSON, carrying `repo`, `number`, `head` and `base` — review exactly that pull request. The record already names the target, so read nothing from a forge to establish it: the review object is the diff of that head against that base. Fetch the base first (`git fetch origin <base>`) and diff against the fetched ref (`git diff origin/<base>...HEAD`): a local `<base>` branch can lag the forge's base during a long run, and a stale base reviews a diff the pull request does not have. Do not resolve a PR from the current branch, and do not accept a different target.
- A PR number, URL, or branch → resolve it with `gh pr view` (title, body, base, head, state, files) and `gh pr diff`. Make sure the PR's head is what the local checkout reflects; note the head SHA. **In PR mode the review object is the PR's diff, exactly — uncommitted or untracked local state is out of scope and must not appear in the scope file.**
- Empty scope → first check whether the current branch has an open PR (`gh pr view`); if it does, that PR is the target (PR mode, as above). Otherwise the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch (`git merge-base`, `git diff`, `git log`). Note the current HEAD SHA.

## Resolve the accepted contract

The review judges the change against what the contract says completion looks like, so resolve the contract in full, in every mode, including light mode.

- When `work_order` is non-empty, read it in full, then follow it to the **originating contract**: the issue, request, or document the work order, or a document it points to, names as its source. Read that source yourself. Triage summaries, plans, and a previous review report are derived from it: a summary is where an acceptance line gets lost, a plan's own design decisions are not steering, and a contract a previous round recorded is not a source. The originating contract, as settled by the work order, is the accepted contract implementation received. Preserve its required outcome, explicit non-goals, and boundaries as prose; do not parse it with scripts, regexes, or keyword extraction.
- When `work_order` is empty and the target is a PR, use the PR body's problem/outcome and explicit scope or non-goals as the standalone review contract, following it to any source it names in the same way. Do not infer a broader promise from the changed files.
- When neither supplies an explicit boundary, state that the review is using the requested scope and repository contracts without inventing a non-goal.

From the originating contract, list every **acceptance** item (how completed behavior will be recognized), every stated **invariant**, and every **steering** constraint on how the work is done, each as its own numbered item, quoted as the contract words it. A document that counts, mentions, or paraphrases acceptance without stating each item has not given you the items; go to its source. When you cannot reach a source the contract depends on, say which items could not be read rather than standing in other text for them. Finding these items is your reading of the contract, not a parse: never extract them with scripts, regexes, or heading matches, and never invent an item the contract does not state.

A derived document decides how the work is done; it cannot drop what the originating contract requires. When one declares out of scope something the originating outcome, acceptance, or invariants require, keep the originating item, and record the narrowing under the contract as a conflict for the reviewer to judge rather than as an accepted non-goal.

## Select docs review

Set `docs` true when the reviewed diff changes shipped documentation, unless the
diff is small, mechanical, and likely-correct — a version bump, a one-line fix, a
rename, a test-only tweak — in which case a doc-adjacent touch alone does not
earn the lens. Otherwise set it false. This selection applies only when the
workflow's `docs` input is `auto`; an explicit input overrides it.

## Light mode (a prior report exists)

When a prior-report path is supplied, require that it exists and read it in full. A missing supplied report is a broken continuation contract: fail with the path named instead of silently starting a full review. Extract its **reviewed-head cursor** (the SHA it records). For a PR target, this round's diff is **only the delta**: `git diff <cursor>..HEAD`. For a working-diff target, include that delta plus any uncommitted changes. The prior report remains the sole owner of earlier findings and review coverage; do not copy or rebuild them in scope.md. The accepted contract is not among them: resolve it from its source as above, never by copying the prior report's contract section.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing:

1. **Accepted contract** — the source you read it from (the originating contract, and the work order, PR body, or requested scope/repository contracts that led there); the required outcome; then three subsections, **Acceptance**, **Invariants**, and **Steering**, each holding its numbered quoted items or the sentence that the contract states none of that kind or that its items could not be read; then explicit non-goals or boundaries and any recorded narrowing.
2. **Target** — PR reference or "working diff", base branch, and the **head SHA under review** (this becomes the next round's cursor).
3. **Mode** — full review, or light (delta since `<cursor>`).
4. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
5. **The diff to review** — inline when small; for a large diff, the exact commands a reviewer runs to see it (`git diff <range>`).
6. **Prior report** — continuation mode only: its path and reviewed-head cursor. Do not duplicate its findings or coverage.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the accepted contract's source, has all three of its Acceptance, Invariants, and Steering subsections, names the head SHA, and that the diff commands in it actually produce output in this checkout. Then declare:

- `docs`: the boolean selected above.
- `pr`: the qualified pull request this round reviews, as `{"repo": {"host": ..., "path": "owner/repo"}, "number": N}` — the same identity scope.md records. For a working-diff target, `{}`. The node that publishes the review report writes to this record and to nothing else, so a wrong or guessed identity would put the report on the wrong pull request.
