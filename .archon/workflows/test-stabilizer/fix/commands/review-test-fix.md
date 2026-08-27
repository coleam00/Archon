---
description: Independently review a stabilizer diff against its original diagnoses.
argument-hint: concern, raw diagnoses, implementation report, and validation result
---

# Independent test-scope review

You are a fresh reviewer, not the implementer. Modify nothing.

Concern ownership:

```json
$INPUTS.order
```

Authoritative assessor outputs:

```json
$INPUTS.diagnoses
```

Implementer report:

```json
$INPUTS.implement
```

Deterministic local validation:

```json
$INPUTS.verification
```

Read the complete validation artifacts named in that object. They are not
truncated; do not judge a failure from an excerpt.

Inspect the complete diff against `$BASE_BRANCH` and the relevant current code.
Review only test correctness and class drift:

1. Every diagnosis assigned by `order.diagnosis_ids` is addressed.
2. The diagnosed mechanism is gone, not moved into a shared hook, concurrent
   fan-out, helper, or another deadline.
3. Every behavioral invariant remains meaningfully asserted.
4. No timeout increase, retry, sleep, tolerance widening, skip, platform guard,
   or assertion weakening was introduced.
5. The targeted and broad commands are appropriate. A local validation result
   with `green: false` is authoritative and must be rejected.

Approve only when all five hold. Findings must cite a diagnosis ID, concrete
diff evidence, and the required correction. Structured output only.
