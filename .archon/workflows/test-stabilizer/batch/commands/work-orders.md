---
description: Group confirmed diagnoses into non-conflicting concern-level work orders.
argument-hint: structured assessor verdicts
---

# Plan concern ownership without rewriting the diagnoses

The assessor outputs below are the authoritative diagnoses. Do not summarize,
rewrite, or reinterpret their mechanisms. Your only judgment is how confirmed
diagnoses should be partitioned into implementation concerns.

Grounding: $INPUTS.grounded

```json
$INPUTS.assessments
```

## Grouping rule

Fan out per coherent concern, not per test and not per whole failure class.

- A concern has one behavioral contract and one implementation approach.
- Group diagnoses that must edit the same files or shared primitive; parallel
  children cannot safely own overlapping edits.
- Split diagnoses that share the high-level failure class but have different
  contracts, files, or primitives.
- Do not group different fix kinds merely because their symptoms look alike.
- Keep only `confirmed: true` diagnoses.

Each order references the original `diagnosis_id` values. Those complete raw
diagnoses are passed independently to the implementer; this node must not turn
them into another prose work order.

Do not copy `kind`, `owned_paths`, `shared_primitives`, or any other diagnosis
field into an order. The deterministic boundary derives them from the selected
assessor outputs. `why_grouped` explains the partition decision only.

Return structured fields only. An empty confirmed set produces `orders: []`.
