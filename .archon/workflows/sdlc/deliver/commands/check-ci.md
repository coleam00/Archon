# Check CI

Check this pull request's CI and leave the pull request ready only when CI is
green. If it is red, find the root cause.

The pull request, as an earlier node recorded it:

$INPUTS.pr

Its work is done: the review converged and the implementer's validation passed.
Its current head is this checkout's HEAD. No one watches this run; your structured
answer is all the next node reads. Use `gh` with `--repo <owner>/<repo>` on every
command, and do not modify files or push.

1. If the pull request is merged, answer `green`: there is nothing to mark. If it is
   closed without a merge, answer `blocked` and say so.
2. Check that the head merges cleanly into its base:
   `gh pr view <number> --repo <owner>/<repo> --json mergeable`, or fetch the base
   and run `git merge-tree --write-tree <remote>/<base> HEAD`. A head that
   conflicts is never marked ready: answer `blocked` and name the conflicting paths.
3. Mark the pull request ready if it is a draft:
   `gh pr ready <number> --repo <owner>/<repo>`. A project whose CI skips draft
   pull requests starts its CI here.
4. Wait for CI to finish, however long it takes, for example with
   `gh pr checks <number> --repo <owner>/<repo> --watch`. If your tool cuts a
   command off early, run it again until every check has finished. Judge the
   checks that gate a merge, whatever CI system the project uses. Do not re-run or
   cancel checks.
5. Green: leave the pull request ready. Red, or any answer other than green: put it
   back to draft with `gh pr ready <number> --repo <owner>/<repo> --undo`, and
   confirm it reads as a draft, before you answer.

## Output

- `state`:
  - `green`: every check that gates a merge passed on the head commit, and the
    pull request is ready.
  - `red`: a check that gates a merge failed on the head commit. The pull request
    is a draft again.
  - `blocked`: the pull request cannot be marked ready (a conflict with its base,
    or it was closed), or CI has no result to wait for (it waits for someone's
    approval, or it does not run on this pull request). The pull request is a
    draft.
- `summary`: for `green`, the checks that passed. For `red`, the root cause: which
  check fails, where, and why, whether that is this pull request's change, a
  failure the base branch already has, or the CI infrastructure. For `blocked`,
  what stops it.
- `evidence`: the checks, runs, log lines and commits you read.
