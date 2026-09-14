# Qualify ordinary merge evidence

Prepared input: $INPUTS.prepared
Requested merge method: $INPUTS.merge_method

Read the exact prepared input file, its external validation/review report, and
the current GitHub facts it contains. Judge whether the evidence establishes the
project's applicable checks and completed independent review for every named PR
head and base, within the requested validation scope/context. Follow explicit
evidence links when needed; do not search native sessions or infer success from a
report's ready=true. Record the exact observations that support your decision.
For every additional local source you rely on, return its canonical absolute path
and the SHA-256 of the bytes you read in supporting_evidence. The sealer and merge
executor verify those hashes. Use an empty array when the prepared report and
GitHub facts contain all the evidence.
An ordinary code/docs contract does not require invented runtime or holdout tests.
If the requested work actually requires runtime evidence, hold for that evidence.

Missing or irrelevant evidence is an evidence hold. Classify a concrete code
defect as code, changed identities as stale, unknown/conflicting rules as policy,
and missing authorization as authorization. Hosted checks are independent facts:
the script refreshes them. No hosted CI is acceptable when policy requires none
and applicable validation/review evidence is sound. Do not manufacture code work
from unknown policy or pending checks. Explain inherited failures using the
actual evidence and the project's acceptance contract.

Read canonical archon-review-report comments at the current head. In a
single-account factory a separate reviewer may use the same login. Treat old
archon-merge-hold comments as prior claims; explain resolved reasons instead of
carrying them forward automatically. No unresolved blocking finding may qualify.

Write the decision to the prepared report_path and return that exact evidence
path. Return ready=true only with no holds, repair=false and no method conflict.
Return the requested method with method_source=caller. When it is empty, use a
mandatory project method with method_source=project or leave both empty for the
repository's sole enabled method. Record conflicting mandatory guidance in
method_conflict; never silently substitute another method.

Keep the source, supplied reports and GitHub unchanged. Do not launch validators,
agents or workflows. The next script seals this judgment, and merge execution
checks applicability without judging these reports again.
