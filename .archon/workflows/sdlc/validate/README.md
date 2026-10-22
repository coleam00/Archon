# Validation

`archon-validate` discovers and runs the project's checks on the current
checkout. Its `scope` input narrows them. It has three steps:

1. `discover` (agent) reads the repository and declares the checks to run, in the
   project's own order, as argv lists, each in a group: independent gates (a
   service and a web app built separately, per-module gates) are separate groups.
   It prefers an aggregate gate script over its parts and puts a locked-mode
   install first when dependencies are missing.
2. `run` (script) runs those checks with no agent involved, so a gate that takes
   longer than an agent's shell tool allows still finishes. Each group stops at its
   first failing check, but every group runs, so one gate's failure never hides
   another's. It writes `validation.md`: each command, its group, its exit status,
   how long it took, and the output tail of a failure. Full output stays in
   `validation/`.
   The checks run without the node's run contract (`WORKFLOW_ID`, `ARTIFACTS_DIR`,
   generated input keys and the rest): they are the project's gate, not part of the run.
   The engine supplies the full run-contract key list in `ARCHON_RUN_ENV_KEYS`,
   including its fixed keys and generated input keys. An independently configured
   `INPUTS_*` setting survives. A generated binding wins a
   same-key project setting and is removed from the gate. The runner requires a valid
   key list and fails before starting checks if it is missing or malformed. Manual
   invocations must supply the full removal list, including `ARCHON_RUN_ENV_KEYS` itself.
3. `classify` (agent) runs only when a check failed, and judges every failure the
   record names. It decides whether the change caused it (`introduced`), the base already had it (`inherited`) or the machine
   did (`environment`).

Green comes from exit statuses alone: every declared check exited 0. When not every
check ran, the result is `green: false` with `red_cause: incomplete`, even if a check
that did run failed; its failure is named in the summary. That happens when a check cannot start, or when the `run`
node's timeout stops the gate. On that timeout the runner kills the running check's
whole process tree, restores anything it moved aside, and records the stop in
`validation.md`. On Windows, or after SIGKILL, the script gets no signal it can
catch: the check's process tree may outlive the timeout, and anything moved aside
stays in the run's artifacts until the next attempt of the run puts it back before
it starts. Restoring never overwrites a path the checkout has again; that moved
copy stays in the artifacts, and `validation.md` names where. SDLC delivery refuses an incomplete result as unfinished rather
than red; the action is to resume the run.
