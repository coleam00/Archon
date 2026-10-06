# Decide whether a red check gets one re-run

CI concluded red on this pull request. Before anyone attributes the failure, decide whether one re-run of the failing checks would tell a flake from a real break, and if so, request it. You change no file, and you never cancel, skip or re-run anything beyond the failing checks, once.

The failing checks, as the CI probe reported them:

$INPUTS.detail

What this project's CI is, as discovered earlier in the run:

$INPUTS.ci

## Judge

A re-run is warranted when the failure does not point at this pull request's changes: it fails in a file the pull request does not change (compare the failing test or file with the diff against the base), the base branch's latest run of the same check passes, and nothing has re-run it yet; or the failure looks like the infrastructure's (a timeout, a lost runner, a network fault). A check the probe lists as `(cancelled)` either never got a runner or ran past its time limit; a red that includes one warrants a re-run even when a summary job that aggregates it also failed. It is not warranted when the failure is in a file this pull request changes, or the same check already failed when re-run.

## Request

When warranted, request one re-run of the failing checks through this CI system's own mechanism (on GitHub Actions, `gh run rerun <run-id> --failed`), covering the cancelled checks as well as the failed ones. A check you cannot re-run from here — an external CI with no re-run access, a missing permission — is not requested; say why.

## Declare

- `requested` — true only when the re-run was actually requested and accepted.
- `reason` — one or two sentences: why a re-run is or is not warranted, and what you requested or why you could not.
