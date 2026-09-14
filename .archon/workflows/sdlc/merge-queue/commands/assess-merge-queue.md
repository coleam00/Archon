# Assess a merge batch

Mechanical GitHub facts: $INPUTS.facts
Additional evidence: $INPUTS.evidence
Requested merge method: $INPUTS.merge_method
Keep the checkout and GitHub unchanged. The supplied facts are the mechanical authority for repository
identity, enabled methods, current heads and bases, effective required-check policy,
check results and review material. Do not replace an unknown policy with an
inference. Require independent review and applicable validation evidence, including
project-required runtime checks. Read supplied reports in full and verify their
source/head matches; a prose assertion that tests passed is insufficient. No
required hosted CI is valid only when the facts say none and the validation
evidence is qualified.

Independent review means a reviewer other than the implementer, not a different
GitHub login. In a single-account factory the same identity pushes the branch and
posts the shared review workflow's canonical report: an issue comment on the PR
beginning with `<!-- archon-review-report -->`. Accept that report as the
independent review when its verdict is ready with no open blocking findings and it
names the PR's current head; a submitted GitHub review is not required. Hold when
the canonical report is missing, not ready, or describes an older head.

Read dependencies and diffs to select an order. Hold if the requested PRs have an
unresolved dependency or incompatible changes; do not silently add PRs to the batch.
Return the exact requested method with source=caller. When the caller left it
empty, return a mandatory method from project guidance with source=project, or
leave it unresolved; the deterministic plan step may select the repository's sole
enabled method. Report a conflict instead of substituting a method. Return evidence
state, a content/applicability fingerprint, and direct references. Stage A accepts
the existing qualified evidence form; it does not invent provenance for prose.
Return ready only when the entire batch is semantically eligible. The next typed
script owns the digest-named merge plan and all GitHub merge mechanics. No code changes,
branch switches, custom worktrees, or agent subprocesses.

Return every hold in the structured assessment. Assessment and preview are
read-only; do not publish comments, edit pull requests, or perform any merge action.
