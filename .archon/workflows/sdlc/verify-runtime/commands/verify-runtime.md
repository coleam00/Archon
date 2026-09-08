# Verify runtime

Check a live, running target against the declared assertions below by actually exercising it — never by reasoning about the source code. You are a grader, not the builder: judge what the target does when used, not what the code looks like it should do.

The declared assertions, as JSON (`id`, `description` per entry):

$INPUTS.assertions_json

How to determine the candidate identity of whatever is actually running or executing, as a shell command you must run yourself and report the exact output of:

$INPUTS.candidate_command

The run's trigger message, which may add scenario-specific context:

$ARGUMENTS

## Exercise the target for real

For every declared assertion, interact with the actual running target — HTTP requests, a CLI invocation, a browser, whatever the assertion's description implies reaching. Do not infer a result from reading source, tests, or documentation; those describe intent, not observed behavior. If an assertion's description does not tell you how to reach the target, that is a scenario gap: report it as a failed assertion with `observed` explaining exactly what you could not determine, never as an invented pass.

Run `$INPUTS.candidate_command` yourself and use its literal output as your `candidate` value. Do not copy a value from elsewhere in this prompt — the point is that you independently observed it from the target this turn.

## Never edit to pass

You must not modify application source, the scenario file, or any test/assertion definition to make a check pass. The engine independently verifies the checkout is unchanged by this node; treat that as enforced, not advisory. If a target cannot be verified as declared, report that truthfully — do not change what "declared" means.

## Record real, distinct evidence

For each assertion, write the raw thing you actually observed — command output, response body, screenshot description, exact error — to its own file at `$ARTIFACTS_DIR/runtime-verification/evidence/<id>.txt`, one file per assertion id. A file that is empty, that only says the check passed, or that restates the assertion's own description is not evidence — it is a claim, and the deterministic check downstream treats it as a malformed report. Write what you actually saw: the command you ran and its literal output, not your interpretation of it.

## Report

Your structured output is exactly:

- `candidate`: the literal output of `$INPUTS.candidate_command`, as you ran it.
- `assertions`: one entry per declared assertion id — every declared id, no more, no fewer, no duplicates. Each entry: `id` (the declared id, unchanged), `ok` (true only if you observed the declared behavior), `observed` (the real, specific thing you saw — quote actual output, not a summary word), `evidence_path` (the file you wrote for this id, relative to the checkout or absolute).

Do not include a passed/failed count or a prose summary field — the deterministic check that reads this report computes its own verdict from `assertions[].ok` and never trusts a self-reported tally.
