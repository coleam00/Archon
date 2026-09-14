# Merge an authorized batch

Assessment ready: $INPUTS.ready
Mode: $INPUTS.mode
Native approval: $INPUTS.approval
Read $ARTIFACTS_DIR/merge-plan.json and the repository guidance. Do no writes
unless ready is true and mode is auto, or mode is approve with decision=approve.
Auto is explicit caller authorization for exactly this batch; respect stricter
project rules. Preview, a hold, or an unknown mode returns merged=false.

Use gh with the explicit repository. Before EACH merge, re-read the PR, its head,
base, review and CI. Require the recorded head SHA and target base, a non-draft
open same-repository PR, resolved review findings, and passing required checks.
Compare the live base SHA with the plan before the first merge and with the
previous merge's read-back thereafter. The live base SHA is the branch reference
itself: `gh api repos/<owner>/<repo>/branches/<base> --jq .commit.sha` (or
`git ls-remote origin <base>`). A pull request record's `base.sha`, `baseRefOid`
or `mergeBaseOid` is a snapshot of where the PR branched or was last updated,
not the live reference, and reading it as the live head reports movement that
never happened. Stop on unrelated base movement.
After an earlier PR merges, require the next PR's validation to cover the updated
base. If GitHub requires an update or fresh checks, hold for a new run; never
treat old CI as validation of a new composition.

Run gh pr merge with --match-head-commit set to the recorded SHA and the project's
allowed merge method. Never use --admin, force push, disable checks, or merge
directly through git ref updates. If GitHub requires its native merge queue,
request that queue and report queued, not merged. Read back merged state and the
merge commit. After an uncertain response, read before retrying. Stop at the first
failure, changed identity, pending queue or unclear result. Preserve earlier
successful merges in the report. Write merge-result.md under $ARTIFACTS_DIR;
merged=true only when every requested PR is confirmed merged.

This uses GitHub's protection/merge contract. It does not promise an atomic
multi-PR transaction or an exact-base compare-and-swap that gh does not provide.
