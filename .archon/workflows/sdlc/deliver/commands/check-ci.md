# Check CI

Check whether this pull request's CI is green. If it is green, the workflow marks
the pull request ready. If it is red, find the root cause.

The pull request, as an earlier node recorded it:

$INPUTS.pr

Its work is done: the review converged and the local gate passed. Judge CI on the
pull request's current head, which is this checkout's HEAD. No one watches this
run; your structured answer is all the next node reads.

Wait for checks that are still running, for example with
`gh pr checks <number> --repo <owner>/<repo> --watch`. Judge the checks that gate
a merge of this pull request, whatever CI system the project uses. Do not modify
files, push, re-run or cancel checks, or change the pull request.

## Output

- `state`:
  - `green`: every check that gates a merge passed on the head commit.
  - `red`: a check that gates a merge failed on the head commit.
  - `blocked`: CI has no result to wait for. It waits for someone's approval, it
    does not run on this pull request, or it has not finished after an hour.
- `summary`: for `green`, the checks that passed. For `red`, the root cause: which
  check fails, where, and why, whether that is this pull request's change, a
  failure the base branch already has, or the CI infrastructure. For `blocked`,
  what CI is waiting for.
- `evidence`: the checks, runs, log lines and commits you read.
