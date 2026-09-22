# Prepare the pull request

Prepare a reviewer-friendly pull request for the committed work. You author files; the
following deterministic node publishes them through the installed forge plugin.

Draft mode is **$INPUTS.draft**. Preserve the draft state of an existing PR.

Resolve the origin repository with `archon forge resolve`. Record the current branch and
full `HEAD` revision. Determine the base from an existing exact-head PR, repository guidance,
and ancestry; never assume `main`. Find an existing PR with `pr.view`, using a qualified
head selector. For a fork PR, preserve its qualified head repository and require
`maintainer_can_modify: true` before pushing. Never force-push.

Verify that the branch is ahead of the chosen base and that the complete merge-base diff
matches the requested work. Read the run artifacts and repository PR template. Write the
final title and body, with concrete validation evidence and any recorded red-gate caveats.
Do not add AI attribution.

Push the exact recorded branch explicitly. Use `git push -u origin <branch>` for a same-repo
head, or the existing fork's explicit normalized repository and branch when maintainer edits
are authorized. Stop on rejection or divergence.

Write the body under `$ARTIFACTS_DIR/pr-body.md`. Then write
`$ARTIFACTS_DIR/pr-intent.json` containing either:

- `existing`: the exact `pr.view` selector for the verified existing PR; or
- `repo`, `headRepo`, `head`, `headRevision`, `base`, `title`, `bodyPath`, and boolean `draft`
  for creation.

The file must contain no credentials or raw remote URL. Return only:
`{"intent":"$ARTIFACTS_DIR/pr-intent.json"}`.
