# Sync the PR description with the final diff

Bring the pull request description back in line with the code after correction
rounds changed it. The description was written when the draft PR opened;
corrections since then may have falsified specific claims in it. Your product is
an accurate PR body — nothing else.

**Read-only on the repository:** never modify files, commit, push, change the
PR's draft state, or touch the canonical review comment. The PR body is the only
thing you may edit.

The target is the run-owned PR, never the current branch's ambient PR mapping:

- Its recorded number is **$INPUTS.pr_number**.
- Its recorded head branch is **$INPUTS.pr_head**.

Derive the origin repository, read that exact PR by number, and fail unless its
head and the checked-out branch both equal the recorded head branch. Use the
recorded number as the selector for every `gh` read or edit.

1. Read the current PR body and the full final diff
   (`gh pr diff <number> --repo <owner/repo>`).
2. Check every concrete claim in the body against the final diff: named
   functions and guards, described mechanics, file lists, "unchanged" claims.
   The Problem section describes the issue and rarely drifts; the Solution and
   review-guidance sections are where correction rounds falsify claims.
3. Edit only what the diff falsifies. Preserve the body's structure, tone, and
   every claim that is still accurate. Do not rewrite from scratch, do not add
   sections, and do not narrate the correction history or this sync.
4. When nothing is falsified, change nothing.
   One exception to "add no sections": the gates record red they let through as
   typed artifacts. Read every `$ARTIFACTS_DIR/nodes/*.meta.json` whose `outputType`
   is `green-gate` and the `.md` beside it; any with a non-empty `red_cause` that the
   body does not already disclose gets that disclosure — its `stage`, `red_cause`, and
   `summary`. A correction round or the project gate can go red after the body was
   written, and a reviewer must not have to discover that from a red badge.
5. After an edit, read the body back (`gh pr view`) and confirm it carries your
   corrections.

Before finishing, re-read the final body once against the diff: every mechanism
it describes must be one the diff actually contains.

Report which claims you corrected and the verified PR URL — or that the body
was already accurate and you changed nothing.
