# Review Scope

Establish exactly what this review round examines, and write it down for the reviewer or reviewers that follow. You do not judge anything; you make the target precise.

## Inputs

**The pull request to review** (may be empty): `$INPUTS.pr`. In delivery this is empty and the change is the one the builder proposed, named in its result below.

**The issue whose change this is** (empty for a review started by hand on a pull request): number `$INPUTS.issue` in `$INPUTS.repo_host`/`$INPUTS.repo_path`.

**What the builder ended with** (`null` for a review by hand): its `pull_request`, the `head` it pushed, and its `report`, the path of its `implementation.md`:

$INPUTS.build

**The previous round's result** (`null` when no review of this item completed before): its `head` is the commit that round reviewed, its `report` the path of its report, beside which its `findings.json` lies.

$INPUTS.earlier

**Commit under review**: this checkout's `HEAD` (`git rev-parse HEAD`), read before anything else. Every diff you record ends at that full SHA, never a branch name or a revision read from a pull-request record. Declare it as `head`.

**Part assignment**: none. This review judges the whole contract.

Decisions an operator already made on this item, oldest first; where two disagree, the later one holds. A decision here is part of the accepted contract:

$INPUTS.answers

The run's trigger message, which may narrow or override the above:

$ARGUMENTS

## Continuation or full review

This round continues the previous one when the previous round's result is not `null`, its `report` file exists, and the commit under review descends from its `head` (`git merge-base --is-ancestor <its head> HEAD`). Then its `head` is the **cursor** this round's delta starts from, and the path of its report is the **prior report**. Otherwise this is a full review. When the previous round's `head` is not an ancestor of the commit under review, say so in scope.md and review in full.

## Resolve the target

- In delivery, the pull request is the builder's `pull_request`: review exactly that pull request. Read it with `pr.view` (below) for its repository and base. Its `head_revision` must be the commit under review: when it is not, someone pushed after the builder or the builder's push did not land, so write that in scope.md, declare it, and the review stops there. The review object is the diff of the commit under review against that base. Fetch the base first, from the remote whose URL is the record's `repo` (`git remote -v`; it need not be named `origin`), and diff against the fetched ref (`git diff <that remote>/<base>...<commit under review>`): a local `<base>` branch can lag the forge's base during a long run, and a stale base reviews a diff the pull request does not have. Do not resolve a PR from the current branch, and do not accept a different target.
- A PR number, URL, or branch → read it through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`: `<argv...> forge pr.view --json --data '<request>'`, with `{"selector":{"kind":"number","ref":{"repo":{"host":…,"path":…},"number":…}}}` for a number or URL (the repository from the URL, or from the checkout's remote), or `{"selector":{"kind":"head","repo":…,"headRepo":…,"head":"<branch>"}}` for a branch, which answers its open pull request or `null`. The answer carries the title, body, state, base, head branch and head revision. Its diff is the commit under review against the base, fetched as above (`git diff <that remote>/<base>...<commit under review>`). **In PR mode the review object is the PR's diff, exactly — uncommitted or untracked local state is out of scope and must not appear in the scope file.**
- Empty → first check whether the current branch has an open PR (`pr.view` with the head selector, as above); if it does, that PR is the target (PR mode, as above). Otherwise the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch (`git merge-base`, `git diff`, `git log`). The head is the commit under review.

## Resolve the accepted contract

The review judges the change against what the contract says completion looks like, so resolve the contract in full, in every mode, including a continuation.

- When the issue is named, it is the **originating contract**: read it, with its comments, through `workitem.view` and `workitem.comments`. Read the builder's work order too when it names one (the plan or investigation report its `implementation.md` cites). Read that source yourself. Triage summaries, plans, and a previous review report are derived from it: a summary is where an acceptance line gets lost, a plan's own design decisions are not steering, and a contract a previous round recorded is not a source. The originating contract, as settled by the work order, is the accepted contract implementation received. Preserve its required outcome, explicit non-goals, and boundaries as prose; do not parse it with scripts, regexes, or keyword extraction.
- When no issue is named and the target is a PR, use the PR body's problem/outcome and explicit scope or non-goals as the standalone review contract, following it to any source it names in the same way. Do not infer a broader promise from the changed files.
- When neither supplies an explicit boundary, state that the review is using the requested scope and repository contracts without inventing a non-goal.

From the originating contract, list every **acceptance** item (how completed behavior will be recognized), every stated **invariant**, and every **steering** constraint on how the work is done, each as its own numbered item, quoted as the contract words it. A document that counts, mentions, or paraphrases acceptance without stating each item has not given you the items; go to its source. When you cannot reach a source the contract depends on, say which items could not be read rather than standing in other text for them. Finding these items is your reading of the contract, not a parse: never extract them with scripts, regexes, or heading matches, and never invent an item the contract does not state.

An explicit narrowing in the operator's trigger is an accepted boundary. The part assignment is the only other authority for deferral. Preserve all originating items and their sources. Match each assignment item to the contract item it quotes, by reading, and record any assignment item that matches none. Mark a contract item deferred only when the trigger explicitly assigns it to a later delivery, or when every part that lists it is numbered above `delivers`, and record its authorization and owning part. Never work out which part owns an item from a plan's prose, including a plan the trigger names. The required outcome follows the same rule as every other item: it is deferred only when the assignment lists it under later parts alone. An item listed under the delivered part, under an earlier part, or under no part, and any unassigned or unexplained omission, is a current requirement. A derived document without that authorization cannot drop originating acceptance: record its narrowing as a conflict. Correctness, truth, documentation and proof inside the delivered slice remain required.

## Continuation (a prior report exists)

When this round continues the previous one, read the prior report in full. The cursor is the previous round's `head` given above, not a SHA you read from the report. This round's diff is **only the delta**, and only this change's part of it: code that arrived through a merge of the base branch is not this change. Fetch the base as above, rebuild the cursor's change on the base the commit under review now sits on, and diff the commit under review against that tree:

```
tree=$(git merge-tree --write-tree "$(git merge-base <remote>/<base> <commit under review>)" <cursor> | head -1)
git diff "$tree" <commit under review>
```

With no base merge between the two commits, the tree is the cursor's own and this is `git diff <cursor>..<commit under review>`. After a conflicting merge `merge-tree` exits non-zero, the first line is still the tree, and the delta shows how this change resolved the conflict, which is this change's work. Record the tree and both commands in scope.md. For a working-diff target, use the base you resolved in place of `<remote>/<base>`, and include any uncommitted changes. The prior report remains the sole owner of earlier findings and review coverage; do not copy or rebuild them in scope.md. The accepted contract is not among them: resolve it from its source as above, never by copying the prior report's contract section.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing the following:

1. **Accepted contract** — the source you read it from (the originating contract, and the work order, PR body, or requested scope/repository contracts that led there); the required outcome; then three subsections, **Acceptance**, **Invariants**, and **Steering**, each holding its numbered quoted items or the sentence that the contract states none of that kind or that its items could not be read; then explicit non-goals or boundaries, each naming its source — the operator's originating contract, or the derived document that inferred it — and any recorded narrowing, the authorized delivery slice, deferred items and their explicit authorization and later owner. When a part assignment is given, record the delivered part, each contract item's owning part or parts, the deferred items, and any assignment item that matches no contract item.
2. **Target** — PR reference or "working diff", base branch, and the **head SHA under review**: the commit under review, in full.
3. **Mode** — full review, or continuation (delta since `<cursor>`).
4. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
5. **The diff to review** — inline when small; for a large diff, the exact commands a reviewer runs to see it (`git diff <range>`).
6. **Prior report** — continuation mode only: its path and reviewed-head cursor. Do not duplicate its findings or coverage.
7. **Builder's report** — the path of the builder's `implementation.md`, from its result, or that there is none for a review by hand.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the accepted contract's source, has all three of its Acceptance, Invariants, and Steering subsections, names the head SHA, and that the diff commands in it actually produce output in this checkout. Then declare:

- `head`: the commit under review, the full SHA.
- `continuation`: true when this round continues the previous one, as above.
- `prior_report`: the path of the prior report on a continuation, otherwise the empty string.
- `head_matches`: true when the target is a pull request whose head is the commit under review, or a working diff; false when the pull request's head is another commit.

- `pr`: the qualified pull request this round reviews, as `{"repo": {"host": ..., "path": "owner/repo"}, "number": N}` — the same identity scope.md records. For a working-diff target, `null`. The node that publishes the review report writes to this record and to nothing else, so a wrong or guessed identity would put the report on the wrong pull request.
- `report`: exactly `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "review/scope.md"}`. The engine refuses this node if that file is missing or empty, so write it before you declare.
