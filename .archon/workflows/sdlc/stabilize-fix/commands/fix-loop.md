---
description: Fix one flaky-test work order in this worktree, discover the project's own commands, commit and push.
argument-hint: the complete work order text
---

# Fix One Work Order

You are fixing exactly ONE flaky/failing test work order. The full brief is
your entire input — no other context exists. If the brief is missing something
decisive (a path that does not exist, an unrunnable command), stop and fail
with what is missing rather than guessing.

Work order:

```
$INPUTS.work_order
```

## Do

1. **Read before theorizing.** Read the named test file, its subject under test,
   and its recent failure evidence from the brief. Establish the healthy
   baseline: run the targeted test once BEFORE changing anything and record the
   result.

2. **Classify honestly, then fix at that level.** The brief names a fix kind.
   Confirm it against what you find; if the evidence points elsewhere, fix at
   the level the code justifies and say so in your summary:
   - `delete-useless-test` — it verifies nothing real; remove it.
   - `make-test-meaningful` — keep the test, rewrite it to pin actual behavior.
   - `fix-product-bug` — the test exposed a real defect; fix the product code.
   - `split-or-recompose-test` — restructure for determinism/composability.

3. **The forbidden shortcuts.** These are never acceptable, in any layer:
   raising timeouts, adding retries or sleeps, widening tolerances, skipping or
   marking tests platform-specific, weakening assertions. A fix that cannot be
   made as prescribed fails loudly with the proof of why instead of disarming
   the alarm.

4. **Discover this project's own commands.** Find its real check/test runner
   from repo config (`package.json` scripts, `Makefile`, CI workflow files).
   Record:
   - `validate_cmd`: the project's own broad check command (lint+tests if one
     script exists)
   - `test_cmd`: a command that runs ONLY the targeted test(s) for this order

5. **Commit and push.** Branch name comes from the work order. Commit message
   describes the outcome, no AI attribution. Push the branch.

6. **Report structured fields only.** Your output is consumed by a machine:
   `branch`, `summary`, `validate_cmd`, `test_cmd`. Output that lands anywhere
   else does not exist afterward.

## Self-check before finishing

Re-read your diff against the brief: does it implement the chosen kind, avoid
every forbidden shortcut, and keep all other tests passing? If any answer is no,
fix that before reporting.
