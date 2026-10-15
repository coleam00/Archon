# Review Scope

Establish exactly what this review round examines, and write it down for the reviewer or reviewers that follow. You do not judge anything; you make the target precise.

## Inputs

**Requested scope** (may be empty):

$INPUTS.scope

**Previous round's report** (path; empty means this is the first round, full review):

$INPUTS.prior_report

**Commit under review**, fixed before this round started: the checkout's HEAD.

$mode.output.head

**Previous round's reviewed commit** (empty on a first round): the cursor this round's delta starts from.

$mode.output.cursor

These two commits are not yours to choose. Every diff you record ends at the commit under review, written as that SHA, never as a branch name or a revision read from a pull-request record. The report that publishes this round must name the commit under review, and head-check refuses before lenses when the checkout or the pull request's remote head is anywhere else, and publication checks again before writing.

**Accepted work order** (may be empty for a standalone review):

$INPUTS.work_order

**Part assignment** (null when this run delivers the whole contract), certified against its schema before this node started:

$mode.output.part

The run's trigger message, which may narrow the review or select a target when the requested scope is empty:

$ARGUMENTS

## Resolve the target

`scope` is an explicit selector: a positive PR number, full PR URL, exact branch name, recorded PR JSON, or empty. The requested nonempty scope is the target and cannot be overridden by the trigger message. Interpret a target in the trigger message only when scope is empty; return its full PR URL as `selector`. Otherwise return the requested selector unchanged, including a recorded delivery PR JSON. The head check resolves the PR from the requested scope, or from your selector when scope is empty. For a number or branch selector, the checkout must have remotes naming one repository; use a full PR URL when several repositories are configured. For an empty selector, look for open PRs for the current branch across the configured forge repositories and head repositories. No match (including no forge remotes, or remotes the forge cannot query) means a working diff; multiple matches require an explicit PR URL. A detached checkout with no explicit selector is a working diff.

- When the requested scope is a recorded pull request — delivery passes its verified record as JSON, carrying `repo`, `number`, `head` and `base` — review exactly that pull request. The record fixes the pull-request identity; read that numbered PR through the selected forge source to establish its current base. It does not name the commit: its `head_revision` was captured when the pull request opened and is stale after any later push, so ignore it. The review object is the diff of the commit under review against the current base. Fetch the base first, from the remote whose URL is the record's `repo` (`git remote -v`; it need not be named `origin`), and diff against the fetched ref (`git diff <fetched-base-SHA>...<commit under review>`): a local `<base>` branch can lag the forge's base during a long run, and a stale base reviews a diff the pull request does not have. Do not resolve a PR from the current branch, and do not accept a different target.
- A PR number, URL, or branch → read its title, body, base, head, state and changed files through the run's selected forge source. For GitHub with the `gh` source, use qualified `gh pr view --repo <host>/<owner>/<repo>` and `gh pr diff` reads. For other hosts (including GitLab merge requests), use the selected forge plugin's `pr.view` operation through `archon forge`, rather than GitHub CLI. Fetch the base from the qualified base repository and use `git diff <fetched-base-SHA>...<commit under review>` for the exact diff. Keep the requested PR as the target even when its head differs from the commit under review. Record that mismatch truthfully in scope.md; the mandatory head-check node stops the run before any lens. Never reinterpret a mismatched PR as a working diff or choose another PR. **In PR mode the review object is the PR's diff, exactly — uncommitted or untracked local state is out of scope and must not appear in the scope file.**
- Empty scope → first look for open PRs for the current branch in the configured forge repositories, using the selected source (`gh pr list --repo <host>/<owner>/<repo> --head <branch> --state open` on GitHub, or the forge plugin's head selector on other hosts). Exactly one match selects that PR (PR mode, as above). No matches selects the working diff: uncommitted changes plus commits ahead of the merge-base with the default/base branch (`git merge-base`, `git diff`, `git log`). Multiple matches require a full PR URL; stop and ask for one. The head is the commit under review.

For every PR target, read its current base branch from the selected forge source, even when delivery recorded an earlier base. Fetch that branch from the qualified base repository, record the branch name and fetched commit SHA in scope.md, and build all full-review diff commands from that SHA.

## Resolve the accepted contract

The review judges the change against what the contract says completion looks like, so resolve the contract in full, in every mode, including light mode.

- When `work_order` is non-empty, read it in full, then follow it to the **originating contract**: the issue, request, or document the work order, or a document it points to, names as its source. Read that source yourself. Triage summaries, plans, and a previous review report are derived from it: a summary is where an acceptance line gets lost, a plan's own design decisions are not steering, and a contract a previous round recorded is not a source. The originating contract, as settled by the work order, is the accepted contract implementation received. Preserve its required outcome, explicit non-goals, and boundaries as prose; do not parse it with scripts, regexes, or keyword extraction.
- When `work_order` is empty and the target is a PR, use the PR body's problem/outcome and explicit scope or non-goals as the standalone review contract, following it to any source it names in the same way. Do not infer a broader promise from the changed files.
- When neither supplies an explicit boundary, state that the review is using the requested scope and repository contracts without inventing a non-goal.

From the originating contract, list every **acceptance** item (how completed behavior will be recognized), every stated **invariant**, and every **steering** constraint on how the work is done, each as its own numbered item, quoted as the contract words it. A document that counts, mentions, or paraphrases acceptance without stating each item has not given you the items; go to its source. When you cannot reach a source the contract depends on, say which items could not be read rather than standing in other text for them. Finding these items is your reading of the contract, not a parse: never extract them with scripts, regexes, or heading matches, and never invent an item the contract does not state.

An explicit narrowing in the operator's trigger is an accepted boundary. The part assignment is the only other authority for deferral. Preserve all originating items and their sources. Match each assignment item to the contract item it quotes, by reading, and record any assignment item that matches none. Mark a contract item deferred only when the trigger explicitly assigns it to a later delivery, or when every part that lists it is numbered above `delivers`, and record its authorization and owning part. Never work out which part owns an item from a plan's prose, including a plan the trigger names. The required outcome follows the same rule as every other item: it is deferred only when the assignment lists it under later parts alone. An item listed under the delivered part, under an earlier part, or under no part, and any unassigned or unexplained omission, is a current requirement. A derived document without that authorization cannot drop originating acceptance: record its narrowing as a conflict. Correctness, truth, documentation and proof inside the delivered slice remain required.

## Light mode (a prior report exists)

When a prior-report path is supplied, read it in full. The cursor is the previous round's reviewed commit given above, not a SHA you read from the report. For a PR target, this round's diff is **only the delta**: `git diff <cursor>..<commit under review>`. For a working-diff target, include that delta plus any uncommitted changes. The prior report remains the sole owner of earlier findings and review coverage; do not copy or rebuild them in scope.md. The accepted contract is not among them: resolve it from its source as above, never by copying the prior report's contract section.

## Write the scope file

Write `$ARTIFACTS_DIR/review/scope.md` containing:

1. **Accepted contract** — the source you read it from (the originating contract, and the work order, PR body, or requested scope/repository contracts that led there); the required outcome; then three subsections, **Acceptance**, **Invariants**, and **Steering**, each holding its numbered quoted items or the sentence that the contract states none of that kind or that its items could not be read; then explicit non-goals or boundaries, each naming its source — the operator's originating contract, or the derived document that inferred it — and any recorded narrowing, the authorized delivery slice, deferred items and their explicit authorization and later owner. When a part assignment is given, record the delivered part, each contract item's owning part or parts, the deferred items, and any assignment item that matches no contract item.
2. **Target** — PR reference or "working diff", base branch, and the **head SHA under review**: the commit under review, in full.
3. **Mode** — full review, or light (delta since `<cursor>`).
4. **Changed files** — path list with a one-line shape of the change per file (added/modified/deleted, rough size).
5. **The diff to review** — inline when small; for a large diff, the exact commands a reviewer runs to see it (`git diff <range>`).
6. **Prior report** — continuation mode only: its path and reviewed-head cursor. Do not duplicate its findings or coverage.

## Verify before finishing

Confirm `$ARTIFACTS_DIR/review/scope.md` exists, names the accepted contract's source, has all three of its Acceptance, Invariants, and Steering subsections, names the head SHA, and that the diff commands in it describe this checkout truthfully, including an empty diff or a PR-head mismatch. Then declare:

- `selector`: the effective explicit selector used to resolve the target, using a trigger-message target only when the requested scope is empty. Use the requested selector unchanged when it is nonempty, and the full PR URL when a message selects a PR. Never replace an unresolved or mismatching PR with an empty selector.
- `report`: exactly `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "review/scope.md"}`. The engine refuses this node if that file is missing or empty, so write it before you declare.
