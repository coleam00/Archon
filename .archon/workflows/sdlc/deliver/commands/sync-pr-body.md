# Sync the PR description with the final diff

Bring the pull request description back in line with the code after correction
rounds changed it. The description was written when the draft PR opened;
corrections since then may have falsified specific claims in it. Your product is
an accurate PR body — nothing else.

**Read-only on the repository:** never modify files, commit, push, change the
PR's draft state, or touch the canonical review comment. Prepare the proposed PR body as output.

The target is the qualified record **$INPUTS.pr**. Read that exact PR with the repository's forge CLI. Fail if its head repository or branches differ from the record, or its head SHA differs from the checkout.

1. Read the current PR body and complete final diff with the repository's forge CLI.
2. Check every concrete claim in the body against the final diff: named
   functions and guards, described mechanics, file lists, "unchanged" claims.
   The Problem section describes the issue and rarely drifts; the Solution and
   review-guidance sections are where correction rounds falsify claims.
3. Edit only what the diff falsifies. Preserve the body's structure, tone, and
   every claim that is still accurate. Do not rewrite from scratch, do not add
   sections, and do not narrate the correction history or this sync.
4. When nothing is falsified, change nothing.
   One exception to "add no sections": if `$ARTIFACTS_DIR/red-causes.json` records
   a red the body does not already disclose, add that disclosure — cause and its
   evidence from `$ARTIFACTS_DIR/implementation.md`. A correction round can go red after the body
   was written, and a reviewer must not have to discover that from a red badge.
5. Return the complete corrected `body` as structured output, including when unchanged. The following deterministic node owns the edit and read-back. Do not perform any public write. Exclude local artifact paths, credentials and private evaluator content.
