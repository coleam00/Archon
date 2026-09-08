# Assess the pinned merge queue

Read the immutable intake below and the pinned local diffs. Propose an order
using importance, file overlap, and possible semantic conflicts. Explain each
placement and classify each PR as `small_bounded`, `risky`, or `large`. Include
every intake number exactly once in both order and judgments.

$INPUTS.intake

Inspect overlapping changes and their callers; individually green changes can
compose into a failure. These judgments advise the supervisor. They never waive
checks or approve a merge. Read only: no edits, checkout changes, pushes, forge
writes, provider launches, or conflict repair. Return the declared structured
assessment. The next native gate owns the approval decision.
