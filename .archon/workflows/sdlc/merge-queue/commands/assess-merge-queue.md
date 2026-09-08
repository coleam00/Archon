# Assess the pinned merge queue

Read the immutable intake below and the pinned local diffs. Propose an order
using importance, file overlap, and possible semantic conflicts. Explain each
placement and classify each PR as `small_bounded`, `risky`, or `large`. Include
every intake number exactly once in both order and judgments.

$INPUTS.intake

Inspect overlapping changes and their callers; individually green changes can
compose into a failure. Judge the actual diff independently of any triage or PR
self-assessment. The complexity vocabulary is the shared triage vocabulary:
`small_bounded` means a focused, contained change with an obvious boundary;
`risky` includes irreversible paths, persisted contracts, security or credentials,
and project-defined risks; `large` means broad surface or more than one reviewable
change. Uncertainty or missing context is `risky`, with the gap named in the reason.
These judgments never waive checks or approve a merge. Read only: no edits, checkout changes, pushes, forge
writes, provider launches, or conflict repair. Return the declared structured
assessment. The deterministic policy decision or a native human gate owns authorization.
