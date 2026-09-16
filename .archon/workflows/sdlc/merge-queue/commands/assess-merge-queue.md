# Assess a merge batch

Requested PR URLs: $INPUTS.prs
Additional evidence: $INPUTS.evidence
Requested merge method: $INPUTS.merge_method
Mode: $INPUTS.mode
Hold-comment publication requested: $INPUTS.publish_holds
Keep the checkout and GitHub unchanged. A later deterministic node owns any hold
comment publication. Read project guidance and use gh with an explicit repository. Require 1-5 distinct same-repository PRs targeting one base.
Reject ambiguous identity, forks, drafts, closed PRs, conflicts, unknown checks,
or unresolved review findings. Read PR bodies, review comments, status checks and
required CI for the current head; pending is not passing. Distinguish a known
repository policy with no required CI (`ci_requirement=none`,
`checks_state=not_applicable`) from an unknown policy and from required checks.
An empty check list proves none of those states. Unknown policy, or required
checks that are failing, pending or missing, holds. Require independent
review and actual validation evidence, including project-required runtime checks.
No checks is not evidence of validation. Read the supplied reports in full and
verify their source/head matches; a prose assertion that tests passed is insufficient.

Independent review means review judgment produced independently from the
implementation. Accept a credible approving GitHub review from someone other than
the implementer, a current external review report in a format the project's
guidance approves, or Archon's canonical report comment beginning with
`<!-- archon-review-report -->`. For any format, require a ready verdict, no open
blocking findings, and evidence bound to the PR's current head. The Archon marker
is one supported format, never a universal requirement. Hold when the available
review is missing, not credible under project guidance, not ready, or stale.

Read dependencies and diffs to select an order. Hold if the requested PRs have an
unresolved dependency or incompatible changes; do not silently add PRs to the batch.
Resolve the requested merge method from the named input and project/repository
policy. It must be exactly merge, squash or rebase. Missing or ambiguous intent,
conflicting sources, and unclear native-queue compatibility return method="" and
hold. Write merge-plan.json under $ARTIFACTS_DIR with this exact shape:
`{"repository":"owner/repo","base":"branch","base_sha":"<sha>","method":"squash","pull_requests":[{"number":123,"url":"https://github.com/owner/repo/pull/123","head_sha":"<sha>"}],"evidence":[{"path":"<exact file path>","sha256":"<sha256 of exact bytes>"}],"reasons":[]}`.
Include every file-backed runtime, validation and review reference relied upon in
`evidence`; missing or unreadable evidence holds. `base_sha`
is the base branch's live head as read from GitHub during this assessment
(`gh api repos/<owner>/<repo>/branches/<base> --jq .commit.sha`), not a PR's
merge base and not a PR record's `base.sha`, which is a snapshot: the merge node
compares the live head against it to detect movement between assessment and
merge. If a PR's validation predates the live base
head, judge that here (GitHub's mergeability and the checks on the current PR head)
rather than recording the older base. Record holds in merge-plan.md. Return ready only when the entire requested batch is
eligible. Compute the SHA-256 of the exact merge-plan.json bytes and return it as
plan_digest. Also return the typed CI requirement/check state and whether ordinary
validation and independent review were verified. Return `eligible=true` only when
every whole-batch eligibility condition above passes. The deterministic gate, not a
lone ready claim, decides eligibility. No code changes, branch switches, custom
worktrees, or agent subprocesses.

Return a unique subset of requested PRs in `holds`, or an empty list when no
comment should change. Use `action=hold` only for a
reason the PR's next commit can fix — an unmet acceptance or project runtime
requirement, stale or blocking review, or a base conflict — and include each
evidence-backed reason. Use `action=clear` when an existing
`<!-- archon-merge-hold -->` comment is now cleared at the current head. Use no
entry for transient holds such as pending checks or base movement, and when there
is no comment to update. The later publisher validates
the requested PR identities, mode, and explicit publication choice. Preview is
read-only even when publication was requested; approve and auto publish only when
`publish_holds=true`. Hold publication never authorizes a merge.
