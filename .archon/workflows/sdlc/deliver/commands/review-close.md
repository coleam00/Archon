# Close the Review

Perform the final, code-scoped closure check after the second correction pass. This is
not another discovery review and it never fixes code.

The current review report is:

`$ARTIFACTS_DIR/review/report.md`

The run's trigger message, which may add context but cannot broaden this closure check:

`$ARGUMENTS`

## Establish the correction delta

Read the report in full. Resolve the PR and confirm the local checkout matches its current
head. The report's reviewed-head SHA is the cursor; inspect only `git diff <cursor>..HEAD`
plus the direct callers and consumers needed to verify that delta.

If there is no report, no reviewed-head cursor, no correction delta, or the checkout does
not match the PR head, return `ready: false` with the exact reason. Do not guess.

## Closure scope

First verify every Critical and Important finding that the report left open. For each one,
record **fixed**, **disproved**, or **still open**, with current `file:line` evidence and the
head SHA. A claimed fix is not enough: trace the corrected path through its direct caller
and consumer, and run the smallest focused check that can prove the behavior when one
exists.

Then review the correction delta for code-correctness regressions introduced by those
fixes. A new blocker is admissible only when all of these are true:

- the correction delta introduced or exposed it;
- a supported, realistically reachable path triggers it;
- the exact failure and consequence are demonstrated from current code;
- it is Critical or Important to the accepted outcome.

Do not report Suggestions, style preferences, speculative hardening, hypothetical edge
cases, extra defensive checks, unrelated debt, new product scope, or tests whose only value
is preserving an implementation detail. Do not reopen a prior finding under a new name.
No new finding is a valid and preferred result when the corrections are sound.

This closure check is deliberately finite. You never edit files, start another fix pass, or
expand into docs, comments, generalized test coverage, type-design, or simplification
reviews. Code behavior is the scope.

## Publish the final truth

Update `$ARTIFACTS_DIR/review/report.md` in place so it remains the canonical complete
report:

- record the current reviewed head SHA;
- preserve every prior finding and its history;
- add a **Closure verification** section with the verdict and evidence;
- make the top-level verdict match the current truth;
- include any admissible new blocker with the next stable finding ID.

When the target is a PR, find its one comment whose body starts with
`<!-- archon-review-report -->`, edit that comment in place to the complete updated report,
and read it back. Never post a second canonical review comment.

## Return

- `ready` — true only when every prior blocker is fixed or disproved and no admissible new
  blocker remains.
- `findings_summary` — one concise statement of the closure result and current head.

Before returning, confirm the report exists, the published comment matches it when a PR is
present, and every cited command actually ran in this session.
