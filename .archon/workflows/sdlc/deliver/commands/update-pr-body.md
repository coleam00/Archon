# Update the pull request description

Bring the pull request's description in line with the final change. It was
written when the draft opened; the base merge and correction rounds since then
may have falsified claims in it, and a validation may have passed red it has to
disclose. Your product is an accurate description, nothing else.

The pull request: $INPUTS.pr. Its URL names the repository (`<owner>/<repo>`) and
the number every command below uses.

1. Read the live description (`gh pr view <number> --repo <owner>/<repo> --json body,baseRefName`):
   a person may have edited it since, and their edits stay. Then read the full
   final diff: fetch the base from the remote whose URL is the pull request's
   repository (`git remote -v`; it need not be named `origin`) and diff
   `<that remote>/<base>...HEAD`.
2. Check every concrete claim in the description against the diff: named
   functions and guards, described mechanics, file lists, "unchanged" claims.
   Change only what the diff falsifies. Keep the structure, the tone and every
   claim that is still true. Do not rewrite from scratch, add sections, or narrate
   the correction history.
3. When `$ARTIFACTS_DIR/implementation.md` records a failing check the implementer
   judged `inherited` or `environment`, the description must say so near the top:
   the check and why it is not this change's. Keep an existing disclosure that is
   still true.
4. When something changed, write the complete description to
   `$ARTIFACTS_DIR/pr-body-final.md` and apply it with
   `gh pr edit <number> --repo <owner>/<repo> --body-file "$ARTIFACTS_DIR/pr-body-final.md"`.
   When nothing changed, edit nothing.

Never modify files in the checkout, commit, push, change the pull request's draft
state, or touch the review comment.

## Output

- `changed`: whether you edited the description.
- `summary`: which claims you corrected, or that it was already accurate.
