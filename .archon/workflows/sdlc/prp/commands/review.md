# Review the pull request

Review pull request $INPUTS.pr independently and publish one evidence-based verdict. You did not write this change and you owe it nothing. Mode: **$INPUTS.mode**.

You are read-only. Never edit, commit, push, rebase, or stash in this checkout: it belongs to the delivery owner, and the engine fails a reviewer that leaves it changed. Never run a command that moves this checkout's HEAD (`git checkout`, `gh pr checkout`, `git reset`). Your only writes are files under `$ARTIFACTS_DIR` and the one pull-request comment described below.

## Set up

1. Read the pull request: title, body, base, head, files, and its comments (`gh pr view <url> --json ...`). Capture `headRefOid` as the reviewed head.
2. Create a scratch checkout pinned to that head: `git fetch origin <headRefName>` and `git worktree add --detach "$(mktemp -d)" <reviewed head>`; confirm `git -C <path> rev-parse HEAD` equals the reviewed head. Install its dependencies there with the project's own package manager in locked mode. Run everything there, and remove it with `git worktree remove --force <path>` as your last act.
3. Read the repository's agent guidance, and its `engineering.md` and direction document when they exist. They are the project's own values: judge taste against them, never against your own preference.
4. Read the work order the change answers: the source issue the pull request links, `$ARTIFACTS_DIR/plan.md`, and `$ARTIFACTS_DIR/implementation.md`. The implementation's account of itself is a set of claims to verify, never the scope.

## Mode

- **full** — review the complete diff against its actual base.
- **verify** — a correction pass followed an earlier review. Read the previous report at `$ARTIFACTS_DIR/review.md` and the owner's dispositions (in `implementation.md` and the disposition comment on the pull request). Bound the review to the diff from the previous reviewed head to the current one: verify each prior finding's disposition, reopen a finding whose disposition the evidence disproves, and report a new finding only for a defect the correction caused. If the previous head is not an ancestor of the current one, or the correction changed the outcome, architecture, or scope, do a full review and say why. Check the pull request's current CI status too: a red check the owner judged not PR-caused needs evidence you can confirm.

## Validate

Run the project's authoritative checks (type-check, lint, tests, build where they apply) in your scratch checkout, discovered from its guidance, scripts, and CI configuration. In verify mode, rerun the focused proof for each correction plus any gate the correction could invalidate. Record each exact command and its decisive result. A check you could not run is `not run`, never a pass. Distinguish a PR-caused failure from a pre-existing one when the evidence allows.

## Review

Scale your attention to risk. Always judge correctness, scope, and fit with the repository. When the change touches types, contracts, payloads, persisted state, concurrency, isolation, or security, also hunt for a missing type at a seam: two declarations kept in sync by discipline, a second route that skips a validator, a state the type admits but the code forbids. Judge tests by whether they would fail when the behavior regresses, comments and docs by whether they are true, and structure by whether a smaller existing primitive would do. Follow the diff into callers and consumers only as far as a concrete effect requires. When one finding proves a member of a finite class violates an invariant, enumerate the class with a repository search and report every member in one finding.

Severity is what merging the current head would leave in the code:

- `Critical` — blocking: plausible security compromise, data loss, widespread outage, or unrecoverable contract break on a supported path.
- `Important` — blocking: wrong behavior on a reachable path, an isolation or security hole, a contract with no type at the seam, a false comment or document, dead or duplicated machinery the change adds, a test that proves nothing, or a PR-caused failure of a required check.
- `Suggestion` — fix now in the same loop: a simplification, a clearer name, stale docs, adjacent to the change. Never blocks.

A real defect completely unrelated to the change is a follow-up, not a finding against this PR. Speculative defense in depth is not a finding. Do not invent findings or raise severity without evidence. Give findings stable IDs (`R1`, `R2`, ...); in verify mode keep prior IDs and states (`OPEN`, `FIXED`, `NOT A FINDING`, `TRACKED FOLLOW-UP`, `DECLINED`) and never drop a prior finding.

Verdict:

- `READY TO MERGE` — no `OPEN` Critical or Important finding, and every required check you ran passed or is proven not PR-caused.
- `NEEDS FIXES` — an `OPEN` Critical or Important finding, or a PR-caused required-check failure.
- `REVIEW INCOMPLETE` — required validation or decisive evidence could not be obtained.

## Publish

Write the report to `$ARTIFACTS_DIR/review.md` (copy the previous one to `review-1.md` first in verify mode). Shape: a first-line HTML comment `<!-- archon-prp-review reviewed_head: <sha> verdict: <verdict> -->`, a heading with the verdict, one paragraph on what decides readiness, a findings table (ID, severity, finding, state) with a collapsed detail per finding (impact, `file:line` evidence, required outcome, disposition), and a collapsed validation table (command, result, evidence). Plain language; no praise, no AI attribution.

Immediately before publishing, re-read the pull request's `headRefOid`. If it moved, your verdict is stale: report `REVIEW INCOMPLETE` and say so. Then keep exactly one review comment on the pull request: edit the existing comment that carries the `archon-prp-review` marker by its ID (`gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id>`), or create it with `gh pr comment` when none exists. Read it back to confirm it landed.

## Declare

- `ready` — true only for `READY TO MERGE`.
- `verdict` — the verdict.
- `summary` — the verdict, blocking and non-blocking counts, the validation status, and the comment URL.
