# Review Scope

Establish exactly what this review round examines, and write it down for the reviewer or reviewers that follow. You do not judge anything; you make the target precise.

## Inputs

**Requested scope** (may be empty):

$INPUTS.scope

**Previous round's report** (path; empty means this is the first round, full review):

$INPUTS.prior_report

**Source selection**: a standalone PR review reads pinned Git objects; it never checks out the PR or changes an existing worktree. After this node resolves the PR, mode reads its fresh head and base, fetches them into private refs, and appends exact source and diff commands to this scope file. Downstream reviewers use that pinned section. A working-diff review and a composed delivery review use the actual checkout.

**Accepted work order** (may be empty for a standalone review):

$INPUTS.work_order

**Part assignment** (empty when this run delivers the whole contract; mode validates its schema before lenses run):

$INPUTS.part

The run's trigger message, which may narrow or override the above:

$ARGUMENTS

## Resolve the target

- When the requested scope is a recorded pull request (delivery's JSON record with `repo` and `number`), review exactly that PR in the current build checkout. Ignore a stored `head_revision`; read its current head from the selected forge. Compare that with `git rev-parse HEAD`. If they differ, set `head_matches: false`, write the mismatch and an instruction to push or reconcile the build checkout in scope.md, declare the qualified PR and report pointer, and stop. Never advance or reset the checkout yourself. When they match, fetch its base from the remote whose URL names the PR's repository and describe the checkout diff against that base.
- A PR number, URL, or branch: resolve the qualified PR with `gh pr view` (title, body, base, head, state). Do not compare it with checkout HEAD. Set `head_matches: true`; mode fetches and pins the fresh source after this node. Record the requested PR and contract here; leave the changed-file list and diff commands to mode's pinned section. Do not use `gh pr diff` as an unpinned source.
- Empty scope: first check whether the current branch has an open PR (`gh pr view`). If it does, select it as a standalone PR review above. Otherwise review the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch. Set `head_matches: true`, record the checkout HEAD, base, changed files and exact working-diff commands.

For a PR review, uncommitted and untracked local files are outside the review source. Never use `--branch`, checkout, reset, pull, or merge to prepare a standalone review. Concurrent reviews and the builder may share this repository. Use scratch checkouts at the pinned head when an experiment needs files on disk.

## Resolve the accepted contract

The review judges the change against what the contract says completion looks like, so resolve the contract in full, in every mode, including light mode.

- When `work_order` is non-empty, read it in full, then follow it to the **originating contract**: the issue, request, or document the work order, or a document it points to, names as its source. Read that source yourself. Triage summaries, plans, and a previous review report are derived from it: a summary is where an acceptance line gets lost, a plan's own design decisions are not steering, and a contract a previous round recorded is not a source. The originating contract, as settled by the work order, is the accepted contract implementation received. Preserve its required outcome, explicit non-goals, and boundaries as prose; do not parse it with scripts, regexes, or keyword extraction.
- When `work_order` is empty and the target is a PR, use the PR body's problem/outcome and explicit scope or non-goals as the standalone review contract, following it to any source it names in the same way. Do not infer a broader promise from the changed files.
- When neither supplies an explicit boundary, state that the review is using the requested scope and repository contracts without inventing a non-goal.

From the originating contract, list every **acceptance** item (how completed behavior will be recognized), every stated **invariant**, and every **steering** constraint on how the work is done, each as its own numbered item, quoted as the contract words it. A document that counts, mentions, or paraphrases acceptance without stating each item has not given you the items; go to its source. When you cannot reach a source the contract depends on, say which items could not be read rather than standing in other text for them. Finding these items is your reading of the contract, not a parse: never extract them with scripts, regexes, or heading matches, and never invent an item the contract does not state.

An explicit narrowing in the operator's trigger is an accepted boundary. The part assignment is the only other authority for deferral. Preserve all originating items and their sources. Match each assignment item to the contract item it quotes, by reading, and record any assignment item that matches none. Mark a contract item deferred only when the trigger explicitly assigns it to a later delivery, or when every part that lists it is numbered above `delivers`, and record its authorization and owning part. Never work out which part owns an item from a plan's prose, including a plan the trigger names. The required outcome follows the same rule as every other item: it is deferred only when the assignment lists it under later parts alone. An item listed under the delivered part, under an earlier part, or under no part, and any unassigned or unexplained omission, is a current requirement. A derived document without that authorization cannot drop originating acceptance: record its narrowing as a conflict. Correctness, truth, documentation and proof inside the delivered slice remain required.

## Light mode (a prior report exists)

When a prior-report path is supplied, read it in full. The cursor is `reviewed-head` beside that report, never a SHA extracted from prose. For a standalone PR, mode verifies ancestry and records the correction diff with base merges excluded. For a composed or working-diff review, record that delta yourself using the checkout HEAD and the fetched base: `git merge-tree --write-tree <merge-base of base and head> <cursor>`, then `git diff <result tree> <head>`. A conflicting merge still returns a tree on its first line; the diff includes this change's conflict resolution. Include local changes only in working-diff mode. Do not duplicate earlier findings; the prior report owns them. Resolve the accepted contract from its source again.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing the following:

1. **Accepted contract** — the source you read it from (the originating contract, and the work order, PR body, or requested scope/repository contracts that led there); the required outcome; then three subsections, **Acceptance**, **Invariants**, and **Steering**, each holding its numbered quoted items or the sentence that the contract states none of that kind or that its items could not be read; then explicit non-goals or boundaries, each naming its source — the operator's originating contract, or the derived document that inferred it — and any recorded narrowing, the authorized delivery slice, deferred items and their explicit authorization and later owner. When a part assignment is given, record the delivered part, each contract item's owning part or parts, the deferred items, and any assignment item that matches no contract item.
2. **Target** — PR reference or "working diff", base branch, and the source mode. Standalone PR source details are appended by mode; checkout reviews name the full checkout HEAD.
3. **Mode** — full review, or light (delta since `<cursor>`).
4. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
5. **The diff to review** — inline when small; for a large diff, the exact commands a reviewer runs to see it (`git diff <range>`).
6. **Prior report** — continuation mode only: its path and reviewed-head cursor. Do not duplicate its findings or coverage.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the accepted contract's source, has all three of its Acceptance, Invariants, and Steering subsections, identifies the qualified PR or working diff, and uses the source mode above. For checkout reviews, verify the diff commands. For standalone PRs, mode appends and verifies the source revisions after you finish. Then declare:

- `head_matches`: true for standalone PRs and working diffs, or the composed checkout comparison above.
- `pr`: the qualified pull request this round reviews, as `{"repo": {"host": ..., "path": "owner/repo"}, "number": N}` — the same identity scope.md records. For a working-diff target, `null`. The node that publishes the review report writes to this record and to nothing else, so a wrong or guessed identity would put the report on the wrong pull request.
- `report`: exactly `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "review/scope.md"}`. The engine refuses this node if that file is missing or empty, so write it before you declare.
