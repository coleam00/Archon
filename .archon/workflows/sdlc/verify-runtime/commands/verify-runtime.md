# Verify runtime

Exercise the live target using tools. Judge its behavior against these assertions:

$INPUTS.assertions_json

Run this project command to observe the actual target identity:

$INPUTS.candidate_command

Additional scenario context:

$ARGUMENTS

Do not modify application source, the scenario, or assertion definitions. Do not
infer runtime results from source, docs, existing fixtures, or previous attempts.
Missing instructions, an unreachable target, and checks you cannot perform are
inconclusive. A failed assertion requires observed product behavior that violates
the scenario. Preserve literal measurements, including boolean true or false.

Capture the commands/tools used and their actual output in new evidence files
inside this attempt directory:

$INPUTS.evidence_directory

Write a JSON report at this exact path:

$INPUTS.report_path

The report contains `candidate` (literal target-identity command output, or empty
if unavailable) and `assertions` (one entry per declared id). Each entry contains:

- `id`: the unchanged scenario id.
- `outcome`: `passed`, `failed`, or `inconclusive`.
- `expected` and `observed`: the expected and measured JSON values; use null for
  an unavailable measurement.
- `reason`: explain the comparison or why assessment was impossible.
- `evidence_path`: path relative to the attempt directory, or an absolute path
  inside it, containing this turn's tool output or diagnostic.

The downstream script checks structure, coverage, file presence, and identity.
It cannot prove that model-authored evidence is truthful or that your comparison
is correct. Record actual tool execution so a reviewer can audit those judgments.
Your final chat reply is not parsed; normal engine node completion hands the
report to the checker, including when the report is missing or malformed.
