---
description: Prove or reject one candidate and preserve the complete diagnosis.
argument-hint: one candidate plus its failure-class framing
---

# Diagnose one candidate

Candidate:

```json
$INPUTS.target
```

Failure class: $INPUTS.smell

Read the named test, its subject, and every helper or fixture needed to close
the causal chain. Reproduce or measure at the cheapest authoritative boundary
when practical. Reject the candidate if any load-bearing link remains a guess.

For a confirmed diagnosis, record:

- `diagnosis_id`: copy the candidate `id` exactly.
- `mechanism`: the complete causal chain from code to failure.
- `invariant`: what behavior the test must continue protecting.
- `kind`: delete-useless-test, make-test-meaningful, fix-product-bug, or
  split-or-recompose-test.
- `owned_paths`: every path the smallest responsible fix may need to edit.
- `shared_primitives`: helpers or seams that create edit overlap with siblings.
- `forbidden_residuals`: concrete shapes that would recreate this mechanism,
  including moving the same uncontrolled work under another clock boundary.
- `verification`: one targeted command and the observation that proves the
  mechanism is gone while the invariant remains live.

For a rejected diagnosis, keep the same structured shape, copy the candidate
identity fields, use empty arrays or strings where no confirmed proof exists,
and put the decisive fact in `rejection_reason`.

Structured output only. Modify nothing.

