# Gather the evidence behind a red CI conclusion

The pull request's CI concluded red after its review converged. Before anyone
fixes or waits on it, gather what the failure is and where it lives. No one
watches this run; your structured answer is all the next node reads. A script
then decides the cause from it: a failure located in a file this pull request
changed is introduced whatever you claim, so report locations exactly and let
the rule do its job.

The failing checks, as the CI probe reported them:

$INPUTS.detail

What this project's CI is, as discovered earlier in the run:

$INPUTS.ci

The pull request is the current branch's, opened by an earlier node. Do not
modify any file, and do not re-run, cancel, or otherwise change any check.

## What to find

1. **Where each failure lives.** Read the failing jobs' logs through whatever
   CI system ran them (on GitHub Actions,
   `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`; `gh pr checks`
   names the runs). For every failing test or check, record the source file the
   failure points at: the failing test's file, or the file a compile, lint, or
   type error names. Write each as a repository-relative path with forward
   slashes and no line number. When a failure names no file, such as a job
   that never started or a runner that lost its connection, record no path for
   it and say so in `evidence`. A check the probe lists as `(cancelled)` never
   ran to a result, and a job that only aggregates other jobs (a summary or
   required-checks job) and failed because they were cancelled or skipped
   points at nothing either: record no path for them.
2. **The base commit.** Whether the same check fails on the base branch's
   latest CI run: `fails`, `passes`, or `unknown` when the base has no
   concluded run of that check you can read.
3. **Reruns.** Whether this check was re-run on the same head commit, and how
   the re-run concluded: `fails`, `passes`, or `not_rerun`. A re-run that CI
   cancelled again reproduced no failure; it is not `fails`.

## Your claim

Then claim a cause:

- `introduced` — this branch's changes cause the failure.
- `inherited` — the failure exists without this branch: the same check fails on
  the base commit.
- `environment` — the failure is the CI infrastructure's, not the code's: a
  runner or network failure, a check CI cancelled before it produced a result
  (with any summary job that failed only because of it), or a flake that passed
  when re-run.
- `unavailable` — the evidence that would attribute it cannot be read from this
  run: the logs or the base's result are out of reach.

The decision script holds every claim to its evidence. `inherited` stands only
when the base fails, `environment` only when no re-run reproduced the failure,
and none of them stands when any failing path is a file the pull request changed.
A red that includes a cancelled check and whose failures point at no file is
`environment` however often it was re-run.
A failure in no changed file, on a base that passes, that a re-run did not
reproduce is `environment`; one a re-run reproduced is `introduced`.

## Output

- `failing_checks`: the name of every failing check.
- `failing_paths`: every source file a failure points at, as above.
- `base`: `fails`, `passes`, or `unknown`.
- `rerun`: `fails`, `passes`, or `not_rerun`.
- `claim`: `introduced`, `inherited`, `environment`, or `unavailable`.
- `evidence`: two to four sentences naming the log lines, runs, and commits you
  read for each of the above.
