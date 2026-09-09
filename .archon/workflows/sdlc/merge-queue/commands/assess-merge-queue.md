# Assess a merge batch

Requested PR URLs: $INPUTS.prs
Additional evidence: $INPUTS.evidence
Keep the checkout unchanged; the only GitHub write here is the hold comment
described below. Read project guidance and use gh with an explicit repository. Require 1-5 distinct same-repository PRs targeting one base.
Reject ambiguous identity, forks, drafts, closed PRs, conflicts, unknown checks,
or unresolved review findings. Read PR bodies, review comments, status checks and
required CI for the current head; pending is not passing. Require independent
review and actual validation evidence, including project-required runtime checks.
No checks is not evidence of validation. Read the supplied reports in full and
verify their source/head matches; a prose assertion that tests passed is insufficient.

Independent review means a reviewer other than the implementer, not a different
GitHub login. In a single-account factory the same identity pushes the branch and
posts the shared review workflow's canonical report: an issue comment on the PR
beginning with `<!-- archon-review-report -->`. Accept that report as the
independent review when its verdict is ready with no open blocking findings and it
names the PR's current head; a submitted GitHub review is not required. Hold when
the canonical report is missing, not ready, or describes an older head.

Read dependencies and diffs to select an order. Hold if the requested PRs have an
unresolved dependency or incompatible changes; do not silently add PRs to the batch.
Write merge-plan.json under $ARTIFACTS_DIR with repository, base, base_sha,
ordered PR number/url/head_sha entries, evidence references and reasons. `base_sha`
is the base branch's live head as read from GitHub during this assessment, not a
PR's merge base: the merge node compares the live head against it to detect
movement between assessment and merge. If a PR's validation predates the live base
head, judge that here (GitHub's mergeability and the checks on the current PR head)
rather than recording the older base. Record holds in merge-plan.md. Return ready only when the entire requested batch is
eligible. No code changes, branch switches, custom worktrees, or agent subprocesses.

A hold recorded only under this run's artifacts is a hold nobody sees, and in an
unattended factory the PR then sits open forever. When a PR is held for a reason
its own next commit can fix — an acceptance criterion or runtime contract the diff
does not meet, a canonical review that is missing, not ready, or stale, a conflict
with its base — publish the hold on that PR as one issue comment whose first line
is `<!-- archon-merge-hold -->`, naming the head SHA assessed and each reason with
the evidence that proves it (the criterion quoted, the code that misses it). Search
the PR's comments for that marker first and edit the existing comment in place;
never append a second. When a PR carrying the marker is now eligible, edit the
comment to say the hold cleared at the new head. A transient hold — checks still
pending, the base moved — is not published; a later run resolves it without a code
change. The shared review workflow reads this comment when a delivery is re-driven
on the branch, which is how the hold becomes a finding that gets fixed.
