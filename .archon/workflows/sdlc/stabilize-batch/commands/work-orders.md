---
description: Merge confirmed assessments into self-contained work orders — dedupe, classify, brief.
argument-hint: confirmed verdicts from the assess fan-out
---

# Work Orders: Confirmed Verdicts In, Parallel-Fix Briefs Out

You receive deep assessment verdicts — one per candidate, already proven or
rejected by per-target assessors. Your job is mechanical synthesis: keep the
confirmed ones, dedupe shared mechanisms, write each as a complete standalone
brief. No re-investigation; the evidence bars were applied upstream.

Grounding context (one line): $INPUTS.grounded

Verdicts:

```json
$INPUTS.assessments
```

## Method

1. **Keep only `confirmed: true`.** Rejected candidates are done — their
   rejection reasons are final and are NOT your concern to relitigate or record.

2. **Dedupe by mechanism, not by file.** Two findings sharing one root cause
   — any shared fixture, helper, or dependency both tests sit on — are ONE
   order covering all affected files: parallel children cannot coordinate
   edits, and two orders touching the same underlying cause would collide.
   Different tests failing from genuinely independent causes stay separate
   orders even if they look similar.

3. **Write each order as a complete brief** a competent engineer with no other
   context acts on:
   - file paths (all of them, when an order covers multiple files)
   - runnable test id(s)
   - the proven mechanism, with its numbers
   - the assessed fix kind AND the assessor's why
   - the forbidden-shortcut list, verbatim: no timeout raises, no retries,
     no sleeps, no skips or platform guards, no tolerance widening, no
     assertion weakening — at any layer
   - verification commands: which proves the targeted test(s), which proves
     the project
   The right fix is never "make CI pass"; the kind taxonomy above IS the fix.

4. **Branch slugs**: `fix/flaky-<short-name>`, unique across orders, derived
   from the primary file/test name.

## Output contract

Structured fields only. Each order becomes one child run's entire world.
Nothing outside the declared fields exists afterward. If zero verdicts were
confirmed, return an empty orders array — an honest empty batch beats invented work.
