# Decide whether a red check gets one re-run

CI concluded red on this pull request. Before anyone attributes the failure, decide whether one re-run of the failing checks would tell a flake from a real break, and if so, request it. You change no file, and you never cancel, skip or re-run anything beyond the failing checks, once.

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

## Request

Only a `flake` or `infrastructure` failure is re-run. A `break` or `unknown` failure is never re-run: it goes straight to classification. When warranted, request one re-run of the failing checks through this CI system's own mechanism (on GitHub Actions, `gh run rerun <run-id> --failed`), covering the cancelled checks as well as the failed ones. A check you cannot re-run from here — an external CI with no re-run access, a missing permission — is not requested; say why.

## Declare

- `failure` — `flake`, `infrastructure`, `break`, or `unknown`, as judged above.
- `requested` — true only when the re-run was actually requested and accepted; always false for `break` and `unknown`.
- `reason` — one or two sentences: why a re-run is or is not warranted, and what you requested or why you could not.
