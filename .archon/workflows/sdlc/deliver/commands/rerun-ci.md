# Decide whether a red check gets one re-run

CI concluded red on this pull request. Before anyone attributes the failure, decide whether one re-run of the failing checks would tell a flake from a real break. You only decide: you change no file and touch no check.

The failing checks, as the CI probe reported them:

$INPUTS.detail

What this project's CI is, as discovered earlier in the run:

$INPUTS.ci

## Judge

Decide this before you touch any check, and declare it as `failure`:

- `flake` — the failure does not point at this pull request's changes and nothing has re-run it yet: it fails in a file the pull request does not change (compare the failing test or file with the diff against the base), and the base branch's latest run of the same check passes.
- `infrastructure` — the infrastructure failed, not the code: a timeout, a lost runner, a network fault. A check the probe lists as `(cancelled)` either never got a runner or ran past its time limit; a red that includes one is infrastructure even when a summary job that aggregates it also failed.
- `break` — the failure points at a real break: it is in a file this pull request changes, or the same check already failed when re-run.
- `unknown` — the logs or the base's result are out of reach, so you cannot tell.

## Ask

Ask for a re-run only for a `flake` or `infrastructure` failure. A `break` or `unknown` failure goes straight to classification. You do not re-run, cancel, or otherwise touch any check yourself: the workflow re-runs the failing checks when you ask, through whatever re-run this CI offers, and reports when it cannot.

## Declare

- `failure` — `flake`, `infrastructure`, `break`, or `unknown`, as judged above.
- `requested` — true when one re-run of the failing checks should be requested; always false for `break` and `unknown`.
- `reason` — one or two sentences: why a re-run is or is not warranted.
