# Publish the backlog as GitHub issues

Mode: $INPUTS.mode
Native approval: $INPUTS.approval

Read `$ARTIFACTS_DIR/backlog.json` (validated) and `$ARTIFACTS_DIR/backlog.md`.
Only `auto`, explicitly selected by the caller, or `approve` with a native decision
of `approve` authorizes writes. Otherwise return `published=false` with empty
`created` and `existing` and write nothing.

Use `gh` scoped to the origin repository's exact `owner/repo`.

Before any write, list every open and closed issue once, with bodies:
`gh issue list --repo <owner/repo> --state all --limit 1000 --json number,url,body`.
Write the output to a file and read it from there. If that listing fails or returns
nothing you can parse, create nothing: return `published=false` and say why. Never
put the marker's comment syntax (`<!--`, `-->`) in a command-line argument or a
search query: shells pass `-->` to `gh` as a flag, and the duplicate check then
silently does not run (seen live).

Then work in backlog order, one ticket at a time:

1. The ticket's marker is the line `<!-- archon-backlog: <key> -->`. If any listed
   issue's body contains that exact line, record that issue's URL under `existing`
   and move on: never post the ticket twice.
2. Otherwise create the issue with `gh issue create` from a body file: the ticket
   body, then a blank line, then `Depends on: #<n>` for each dependency using the
   numbers created or found earlier in this run, then the marker as the last line.
   Use the repository's issue template if one exists. Read the created issue back and
   record its URL under `created`.
3. After an uncertain write, read before retrying. Never retry a create blindly.

Write `$ARTIFACTS_DIR/backlog-publication.md` with every ticket, its outcome and URL.
Return `published=true` only when every ticket was created or already present, plus
the `created` and `existing` URL lists and a one-paragraph `summary`. Partial
failure is reported truthfully as `published=false` with what did land.
