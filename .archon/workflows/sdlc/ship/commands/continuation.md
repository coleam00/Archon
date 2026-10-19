# Resolve the continuation repository

Resolve the qualified identity of pull request `$INPUTS.pull_request` before delivery. Read the run's target (`$INPUTS.target`, or the trigger message when empty) and `$ARTIFACTS_DIR/triage.md` in full. Use that context and the checkout's remotes to identify the repository the PR targets. In a fork checkout this can be upstream; never let a bare number default to the fork. Do not print credential-bearing remote URLs. If the evidence is ambiguous, fail with the ambiguity rather than guessing.

Verify the exact number with the selected source, `$INPUTS.source`. For `gh`, use `gh pr view <number> --repo <host>/<path> --json number,url`. For `forge`, use the argv array in `$ARCHON_CLI_COMMAND` followed by `forge pr.view --json --data` with `{"selector":{"kind":"number","ref":{"repo":{"host":…, "path":…},"number":…}}}`. A failed read fails this node; never retry it through another source.

Return the verified `repo` (`host`, `path`) and `number`. Do not change the checkout or write to the forge. The following script fetches the head and fast-forwards to that exact commit before delivery; it refuses divergent local history.
