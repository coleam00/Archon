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

Read dependencies and diffs to select an order. Hold if the requested PRs have an
unresolved dependency or incompatible changes; do not silently add PRs to the batch.
Write merge-plan.json under $ARTIFACTS_DIR with repository, base, base_sha,
ordered PR number/url/head_sha entries, evidence references and reasons. Record
holds in merge-plan.md. Return ready only when the entire requested batch is
eligible. No code changes, branch switches, custom worktrees, or agent subprocesses.
