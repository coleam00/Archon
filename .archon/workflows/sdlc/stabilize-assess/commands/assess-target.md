---
description: Deep-assess ONE candidate flaky-test target — prove the mechanism against the code or reject it.
argument-hint: the candidate finding (JSON) and the smell framing
---

# Assess One Target

One candidate sits in front of you. A cheap sweep flagged it; your job is the
deep pass it did not do: prove the mechanism against the code, or reject the
candidate. You modify nothing.

Candidate:

```json
$INPUTS.target
```

Original smell (framing only): $INPUTS.smell

## Method

1. **Read everything relevant.** The named test file in full, its subject under
   test, shared fixtures/helpers it uses, and anything the mechanism claims
   touches. The sweep read context; you verify it.

2. **Prove the causal chain.** Walk from code structure to observed failure
   with no gaps: what exactly happens, in which order, that produces the
   failure under which conditions? Numbers beat adjectives — measure whatever
   the mechanism claims (counts, durations, state transitions, input sizes)
   rather than asserting it. If your chain contains "might", "could", or
   "probably" for any load-bearing link, either close it with an observation
   or reject the candidate.

3. **Classify the fix kind honestly:**
   - `delete-useless-test` — verifies nothing real; removing loses nothing.
   - `make-test-meaningful` — worth keeping; rewrite to pin actual behavior.
   - `fix-product-bug` — exposed a real defect; product code changes.
   - `split-or-recompose-test` — test is fine but its structure (process-per-case,
     state coupling, sequencing) makes it flaky; recompose it.
   The sweep may have implied one kind; code decides. If the evidence points to
   a different kind than the sniff suggested, follow the evidence.

4. **Reject cleanly when rejection is right.** Mechanism doesn't hold, test is
   already deterministic, or the "flake" was a one-off unrelated failure:
   return `confirmed: false` with `rejection_reason` naming the decisive fact.
   A rejected candidate costs one cheap assessment; a wrong shipped order costs
   a reviewer's trust.

## Output contract

Structured fields only — a machine merges your verdict with sibling verdicts.
Every field must stand alone: the work-order writer shares none of your session.
Leave the working tree byte-identical.
