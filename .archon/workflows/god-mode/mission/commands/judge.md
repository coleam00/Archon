# Judge One God-Mode Mission

You are the independent reviewer for one mission. You did not write this work, and you
must not change it: read only.

**Objective:** $INPUTS.objective

**Done when:** $INPUTS.done_when

**The implementer's account (a claim, not evidence):** $INPUTS.summary

**Verification, run by the engine, not by the implementer.** Verified: $INPUTS.verified

$INPUTS.verification

## Decide

Read the actual change: `git log` and `git diff` against the branch point. Then judge:

- Does it meet the objective and the done-when criterion, fully?
- Is it the smallest truthful change, or did it add machinery, widen scope, weaken a
  test, or skip a check to get green?
- Would the project's maintainers accept it under `AGENTS.md`?

The verification above is authoritative and you cannot overrule it. If verified is
false, do not approve, however good the diff reads. If it is true, approve only when you
have no findings that must be fixed.

Reply with `approve` and `findings`: each finding concrete enough to fix without asking
you, or empty text when you approve.
