# Verify runtime

Exercise the live target using tools. Judge its behavior against these assertions:

$read-scenario.output.assertions_json

Run this project command to observe the actual target identity:

$read-scenario.output.candidate_command

Additional scenario context:

$ARGUMENTS

Previous report feedback (empty on the first attempt):

$prepare-attempt.output.report_feedback

This is the checker's report rejection reason, not a previous product observation.
Correct the report defect and collect fresh tool evidence against this attempt's
newly started target; do not reuse previous observations or evidence files.

Do not modify application source, the scenario, or assertion definitions. Do not
infer runtime results from source, docs, existing fixtures, or previous attempts.
Missing instructions, an unreachable target, and checks you cannot perform are
inconclusive. A failed assertion requires observed product behavior that violates
the scenario. Preserve literal measurements, including boolean true or false.

The engine retains returned tool output and supported image attachments under this
attempt directory. Read its captures/manifest.json to identify completed tool calls
and their receipts; do not create, edit or reconstruct receipts or captured outputs:

$prepare-attempt.output.directory

Write a JSON report at this exact path:

$prepare-attempt.output.report_path

The report contains `candidate` (a string containing the target-identity command
output with leading and trailing whitespace removed, or empty if unavailable)
and `assertions` (one entry per declared id). This canonical identity removes
surrounding spaces, tabs, and LF/CRLF line endings; interior characters stay exact.
The checker applies the same normalization to the expected input, probe output,
and reported string, so literal command output with a final newline is accepted.
Preserve the raw command output in evidence. Each assertion entry contains:

- `id`: the unchanged scenario id.
- `outcome`: `passed`, `failed`, or `inconclusive`.
- `expected` and `observed`: the expected and measured JSON values; use null for
  an unavailable measurement.
- `reason`: explain the comparison or why assessment was impossible.
- `evidence`: a nonempty array of `{ "pass": "attempt-uuid", "call_id": "provider-call-id" }`
  references from the manifest. Use the enclosing pass's `producer.attempt`; call IDs
  are unique only within that pass. For image evidence add `"attachment": 0`, the
  attachment index in that receipt. A tool's prose claim to have saved an image is insufficient.
  Use only full captures with success or error outcomes. Empty captured output and
  nonzero command exits are valid observations when they support the assertion.

The downstream script checks coverage, producer ownership, captured-byte hashes,
completeness and target identity. It cannot prove application behavior or that your
comparison is correct. Inspect the actual retained observations against each
expectation; irrelevant output cannot support a passed assertion. Truncated,
redacted or unavailable captures require a fresh focused probe, not manual recovery
from a provider session or a PowerShell transcript. Each result is limited to 1 MiB;
the node retains at most 16 MiB and 256 calls.
Your final chat reply is not parsed; normal engine node completion hands the
report to the checker, including when the report is missing or malformed.
