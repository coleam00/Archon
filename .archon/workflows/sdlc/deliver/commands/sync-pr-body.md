# Sync the PR description with the final diff

Bring the pull request description back in line with the code after correction
rounds changed it. The description was written when the draft PR opened;
corrections since then may have falsified specific claims in it. Your product is
an accurate PR body — nothing else.

**Read-only on the repository:** never modify files, commit, push, change the
PR's draft state, or touch the canonical review comment. The PR body is the only
thing you may edit.

The target is the current branch's open PR on the origin repository. Resolve it
with an explicit selector — `gh` disables branch inference when `--repo` is
used, so always pass the branch: `gh pr view "$(git branch --show-current)"
--repo <owner/repo>`.

1. Read the current PR body and the full final diff
   (`gh pr diff <branch> --repo <owner/repo>`).
2. Check every concrete claim in the body against the final diff: named
   functions and guards, described mechanics, file lists, "unchanged" claims.
   The Problem section describes the issue and rarely drifts; the Solution and
   review-guidance sections are where correction rounds falsify claims.
3. Edit only what the diff falsifies. Preserve the body's structure, tone, and
   every claim that is still accurate. Do not rewrite from scratch, do not add
   sections, and do not narrate the correction history or this sync.
4. When nothing is falsified, change nothing.
5. After an edit, read the body back (`gh pr view`) and confirm it carries your
   corrections.

Before finishing, re-read the final body once against the diff: every mechanism
it describes must be one the diff actually contains.

Report which claims you corrected and the verified PR URL — or that the body
was already accurate and you changed nothing.
