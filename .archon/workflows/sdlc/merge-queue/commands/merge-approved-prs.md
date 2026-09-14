# Merge an authorized batch

Previous merge result: $LOOP_PREV.execute.output
Read $ARTIFACTS_DIR/merge-plan.json and the repository guidance. This node only
refreshes facts and returns a typed request; it never merges or performs another
semantic validation pass. The following workflow script owns the write boundary.
Return authorized=false for changed plan or exhausted/unclear state. Native mode
and approval authorization are enforced separately at the script write boundary.

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

Return only the next ordered plan entry as repository, number, head_sha and method,
with authorized=true after those fresh checks pass. The script validates those
values against the approved plan and invokes gh with the exact method and pinned
head. If GitHub requires its native merge queue, the script reports queued, not
merged. Stop at the first failure, changed identity, pending queue or unclear result.

This uses GitHub's protection/merge contract. It does not promise an atomic
multi-PR transaction or an exact-base compare-and-swap that gh does not provide.
