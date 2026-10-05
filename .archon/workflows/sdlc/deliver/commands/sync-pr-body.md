# Sync the PR description with the final diff

Bring the pull request description back in line with the code after correction
rounds changed it. The description was written when the draft PR opened;
corrections since then may have falsified specific claims in it. Your product is
an accurate PR body — nothing else.

**Read-only everywhere:** never modify files, commit, push, change the PR's
draft state, touch the canonical review comment, or write to the pull request.
The node after this one owns the edit and verifies it.

The target is the run-owned PR, never the current branch's ambient PR mapping:

$INPUTS.pr

Its current description was read from the forge and written to
**$INPUTS.current_body**. Confirm the recorded head branch equals the
checked-out branch before judging anything.

1. Read that body file and the full final diff against the recorded base:
   fetch the base from the remote whose URL is the pull request's repository
   (`git remote -v`; it need not be named `origin`), then diff `<that
   remote>/<base>...HEAD`. A local `<base>` branch can lag the pull request's base.
2. Check every concrete claim in the body against the final diff: named
   functions and guards, described mechanics, file lists, "unchanged" claims.
   The Problem section describes the issue and rarely drifts; the Solution and
   review-guidance sections are where correction rounds falsify claims.
3. Change only what the diff falsifies. Preserve the body's structure, tone, and
   every claim that is still accurate. Do not rewrite from scratch, do not add
   sections, and do not narrate the correction history or this sync.
4. When nothing is falsified, change nothing. Red a gate let through is not
   yours to disclose: the publishing node puts that section at the top of the
   body from the gates' own records.

Before finishing, re-read your intended final body once against the diff: every
mechanism it describes must be one the diff actually contains.

## Declare

When the body needed changing, write the **complete** intended body — not a
patch — to `$ARTIFACTS_DIR/pr-body-final.md`, then declare:

- `body`: `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "pr-body-final.md"}`,
  copied exactly; or `null` when nothing needed changing.
- `summary`: which claims you corrected, or that the body was already accurate.
