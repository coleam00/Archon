---
description: Implement one concern from authoritative structured diagnoses.
argument-hint: concern ownership, raw diagnoses, and prior independent findings
---

# Implement one diagnosed concern

Concern ownership:

```json
$INPUTS.order
```

Complete assessor outputs:

```json
$INPUTS.diagnoses
```

Original class: $INPUTS.smell

Independent findings from the previous attempt, empty on the first iteration:

```json
$LOOP_PREV.verdict.output.feedback
```

Use only the diagnoses named by `order.diagnosis_ids`. Their mechanisms,
invariants, evidence, forbidden residuals, and verification requirements are
authoritative. Read the current source to confirm it still matches; do not
re-investigate or replace the diagnoses with your own abbreviated theory. If
the source decisively contradicts one, stop and report the contradiction.

Implement the smallest coherent fix inside `order.owned_paths`. The diff must
remove every assigned mechanism without recreating it in another shape. In
particular, moving environment-dependent work into shared setup, concurrent
setup, a hook, or another implicit deadline does not remove a timing class.

Never raise timeouts, add retries or sleeps, widen tolerances, skip or
platform-gate tests, or weaken assertions. Preserve every diagnosed invariant.

Identify the smallest targeted command and the project's broad validation
command, but do not run either: the deterministic verification node owns their
single execution after your edit. Commit and push the branch named by the order.
On correction iterations, address every independent finding, commit, and push
again.

Return structured fields only. `addressed_diagnosis_ids` must contain exactly
the assigned diagnoses actually handled by the diff.
