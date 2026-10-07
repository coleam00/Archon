# Correct the pull request

An independent reviewer has judged your pull request and its CI has concluded. You still own this delivery: in this one pass, disposition every review finding and every red check, fix what matters, and push. There is no later correction pass, so batch every fix now. What you cannot settle ends the run with its reason recorded.

## Read the evidence

- The complete review report at `$ARTIFACTS_DIR/review.md` (its verdict and every finding, not a summary of them).
- The pull request's current checks: `gh pr checks <number>`, and for each failing check its logs (`gh run view <run-id> --log-failed`, or the check's details URL). Note which files and tests each failure lives in.

## Review findings

Judge every finding by its consequence; reviewers can be wrong or just have taste.

- `Critical` and `Important` findings are fixed, or disputed only with decisive evidence that they are wrong or already satisfied.
- Fix the `Suggestion`s that matter now, including adjacent ones that touch what this change works on; code is cheap and a later round is not. Fix taste that fits the project's `engineering.md` and direction document.
- A real finding completely unrelated to this change gets a tracked follow-up: search for an existing issue first and create one only when none exists.
- Decline taste that contradicts the project's docs or has no basis in them, a wrong finding, speculative defense in depth, or overengineering, with the reason. Create no issue for those.

## Red checks

For each failing check, decide its cause from the evidence:

- `introduced` — this pull request caused it: the failure is in code or tests the diff changes or makes reachable. Reproduce it locally, fix the cause, and prove the fix.
- `inherited` — the same check fails on the base branch without this change (compare the base's latest run of that check), or the failure lives in code this diff never touches and the base is red there too.
- `environment` — the runner, network, a timeout on an unchanged path, or a flake the base also shows.

Fix only `introduced` failures. Never edit unrelated code or tests to make an inherited or environmental red go away, never re-run CI jobs, and never merge the base in. Record the evidence for every cause you declare.

## Fix and push

Apply every accepted correction in one coherent pass. Rerun the focused proof for each fix and the project's own type-check, lint, and tests before you push. Commit by outcome (files staged by name, no AI attribution) and push with `git push origin HEAD:refs/heads/$(git branch --show-current)`. Never force-push or rebase. Do not wait for CI after pushing; the run does that.

Then post one comment on the pull request listing every finding's disposition (fixed at `<sha>`, declined with the reason, tracked with its issue link, not a finding with the evidence) and each red check's cause and evidence. Update `$ARTIFACTS_DIR/implementation.md` with the corrections, dispositions, and validation.

## Declare

- `changed` — true when you pushed a new commit in this pass.
- `verify` — true when a fresh verify review must look at this pass: you fixed a blocking finding or a PR-caused red, a fix is itself risky (it changes behavior, or touches a wire format, persisted state, isolation, or security), or you disputed a finding's severity. False when the review was ready and you changed nothing or only made routine Suggestion fixes.
- `ci_cause` — the cause of the red checks that remain after your fixes: `inherited` or `environment` when they were not caused by this pull request, `introduced` when you fixed PR-caused failures, `""` when CI was green.
- `summary` — the dispositions in brief, the CI causes with their evidence, and what still blocks, if anything.
