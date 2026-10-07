# Aggregate and publish the review

You coordinate the review of pull request $INPUTS.pr. Mode: **$INPUTS.mode**. The specialist reviewers have finished. Aggregate their reports into one evidence-based verdict and publish it. Synthesis connects and prioritizes reviewer evidence; it does not perform another code review.

You are read-only in this checkout: never edit, commit, push, rebase, or stash here, and never move its HEAD. Your writes are the report files under `$ARTIFACTS_DIR` and the one pull-request comment described below.

## Read

- `$ARTIFACTS_DIR/review/$INPUTS.mode/brief.md` and `validation.md`: the reviewed head, the review checkout, the risk call, and the repository validation.
- One report per selected scope at `$ARTIFACTS_DIR/review/$INPUTS.mode/<scope>.md`. Selected scopes, one boolean each: $prepare.output A selected scope with no report means that reviewer did not finish: the verdict is `REVIEW INCOMPLETE`, naming the scope. Never treat a missing report as a clean one.
- In verify mode, the previous report at `$ARTIFACTS_DIR/review.md` and the owner's dispositions.

## Synthesize

Lead with the review's central signal: the outcome, the few conclusions that determine readiness, and the common cause when findings converge. Merge duplicate findings into one causal item, attribute every contributing scope, preserve meaningful disagreement, and keep every distinct useful issue the reviewers found. Keep raw reviewer prose and supporting paths in the finding's detail.

Treat reviewer severity labels as advisory. Judge each finding by what merging the current head would leave in the code:

- `Critical` — blocking: a plausible security compromise, data loss or corruption, widespread outage, or unrecoverable contract break on a supported path.
- `Important` — blocking: wrong behavior on a reachable path; an isolation or security hole; a wire or state contract with no type at the seam; a false comment or document; dead or duplicated machinery the change adds; a test that proves nothing; or a PR-caused failure of an authoritative merge gate.
- `Suggestion` — fix now, in the same loop: a simplification, a clearer name, a missing type for an invariant, or stale documentation, in or adjacent to what the change works on. Never blocks.

A real finding completely unrelated to the change is a follow-up, not a fix for this PR. Judge taste by the project's direction and engineering docs: taste they back is a `Suggestion`; taste that contradicts them or has no basis in them is not a finding. Speculative defense in depth is not a finding.

Close a proved causal class before publishing. When an aggregated Critical or Important finding proves that one member of a finite class violates an invariant and no reviewer enumerated the class, run the enumeration yourself as a deterministic repository search in the review checkout, record it in the validation table, and carry every affected and examined-clean member into the finding, so its required outcome covers the class.

Give findings stable IDs (`R1`, `R2`, ...). In verify mode keep prior IDs, allocate new IDs after the prior maximum, verify each disposition, never drop a prior finding, and accept a new finding only when its evidence reaches the correction diff and proves the correction caused it. States: `OPEN`, `FIXED`, `NOT A FINDING`, `TRACKED FOLLOW-UP`, `DECLINED`. Accept `TRACKED FOLLOW-UP` or `DECLINED` only when the evidence confirms the work is not required by the PR's outcome or invariant.

Verdict:

- `READY TO MERGE` — no `OPEN` Critical or Important finding, and all required validation passed or is proven not PR-caused.
- `NEEDS FIXES` — an `OPEN` Critical or Important finding, or a PR-caused required-validation failure.
- `REVIEW INCOMPLETE` — required validation, a selected reviewer's report, or decisive evidence could not be obtained.

## Publish

In verify mode, first copy the previous `$ARTIFACTS_DIR/review.md` to `$ARTIFACTS_DIR/review-1.md`. Write the report to `$ARTIFACTS_DIR/review.md`. Shape: a first-line HTML comment `<!-- archon-prp-review reviewed_head: <sha> verdict: <verdict> scopes: <selected scopes> -->`, a heading with the verdict, one paragraph on what decides readiness, the risk call that picked the scopes, a findings table (ID, severity, finding, state) with a collapsed detail per finding (impact, `file:line` evidence, required outcome, class when one applies, found by, disposition), and a collapsed table of reviewer coverage (each selected scope and its finding IDs, or no findings) and validation (command, result, evidence). Plain language; no praise, no AI attribution.

Immediately before publishing, re-read the pull request's `headRefOid`. If it moved, your verdict is stale: report `REVIEW INCOMPLETE` and say so. Then keep exactly one review comment on the pull request: edit the existing comment that carries the `archon-prp-review` marker by its ID (`gh api -X PATCH repos/<owner>/<repo>/issues/comments/<id>`), or create it with `gh pr comment` when none exists. Read it back to confirm it landed.

As your last act, remove the review checkout named in the brief with `git worktree remove --force <path>`.

## Declare

- `ready` — true only for `READY TO MERGE`.
- `verdict` — the verdict.
- `summary` — the verdict, the selected scopes and the risk call, blocking and non-blocking counts, the validation status, and the comment URL.
