# Check CI

CI is this project's full validation: the implementers ran only focused checks.
Check this pull request's CI, leave the pull request ready only when it is green,
and judge every red.

The pull request is this branch's open pull request in the repository it was
opened against: find it with
`gh pr list --repo <owner>/<repo> --head "$(git branch --show-current)" --state open`.

The review has converged. The pull request's current head is this checkout's
HEAD. No one watches this run; your structured answer is all the next node reads.
Use `gh` with `--repo <owner>/<repo>` on every command, and do not modify files or
push.

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

   When the project has no CI at all, run the project's validation scripts
   yourself, to completion, however long they take: if your tool cuts a command
   off, start it in the background and keep checking until it has finished. Judge
   their result the same way.
5. Judge every red from its logs. It is caused by this change when the failure is
   in code, tests or configuration this pull request changes, or follows from
   them. Anything else is not: the base branch already fails the same way, a flaky
   test, or the CI infrastructure.
6. Green: leave the pull request ready. Red, or any answer other than green: put it
   back to draft with `gh pr ready <number> --repo <owner>/<repo> --undo`, and
   confirm it reads as a draft, before you answer.
7. Write `$ARTIFACTS_DIR/ci.md`, replacing what is there: the head commit you
   judged, the state, whether the change caused it, the summary and the evidence.
   A fixer reads it.

## Output

- `state`:
  - `green`: every check that gates a merge passed on the head commit, and the
    pull request is ready.
  - `red`: a check that gates a merge failed on the head commit. The pull request
    is a draft again.
  - `blocked`: the pull request cannot be marked ready (a conflict with its base,
    or it was closed), or CI has no result to wait for (it waits for someone's
    approval). The pull request is a draft.
- `caused_by_change`: `true` only for a red this pull request's change caused; the
  work then goes back to a fixer. `false` for green, blocked, and any other red,
  which stops the run.
- `summary`: for `green`, the checks that passed. For `red`, the root cause: which
  check fails, where, and why. A fixer reads this to correct a red the change
  caused, so name the failing test or file and the error. For `blocked`, what
  stops it.
- `evidence`: the checks, runs, log lines and commits you read.
