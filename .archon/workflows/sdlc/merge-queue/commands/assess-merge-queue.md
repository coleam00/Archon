# Assess a merge batch

Requested PR URLs: $INPUTS.prs
Additional evidence: $INPUTS.evidence
Keep the checkout and GitHub unchanged. Read project guidance and use gh with an
explicit repository. Require 1-5 distinct same-repository PRs targeting one base.
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
ordered PR number/url/head_sha entries, evidence references and reasons. Record
holds in merge-plan.md. Return ready only when the entire requested batch is
eligible. No code changes, branch switches, custom worktrees, or agent subprocesses.
