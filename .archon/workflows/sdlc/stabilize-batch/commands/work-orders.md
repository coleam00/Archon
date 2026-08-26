---
description: Split sniffed findings into self-contained per-instance work orders with the fix-quality bar baked in.
argument-hint: findings from the sniff node
---

# Work Orders: Split Findings for Parallel Fixes

You receive the sniff's findings and turn them into work orders — one per
instance — that parallel fix agents will act on with ZERO shared context. Each
order must stand completely alone.

Grounding context (one line): $INPUTS.grounded

Findings:

```json
$INPUTS.findings
```

## The fix-quality bar (baked into every order)

LLMs are good at producing bad tests and bad fixes. Forbid it explicitly in
every order. The right fix is NEVER "make CI pass". Every order names exactly
one kind, confirmed against the finding:

- `delete-useless-test` — the test verifies nothing real; removing it loses nothing.
- `make-test-meaningful` — keep a test worth keeping; rewrite it to pin actual behavior.
- `fix-product-bug` — the test exposed a real defect; the product code changes.
- `split-or-recompose-test` — the test is fine but structured so its runtime or state-coupling makes it flaky; recompose it.

Forbidden shortcuts that must appear verbatim in every order as constraints:
no timeout raises, no retries, no sleeps, no skips or platform guards, no
tolerance widening, no assertion weakening — at any layer.

## Order construction

For each finding produce one order:

1. **Confirm the kind yourself.** Read the test and its subject; do not trust
   the sniff's implied framing blindly. A suspected finding whose mechanism you
   cannot confirm gets dropped — say how many you dropped in the last order's
   title suffix? No: record dropped findings nowhere; they return on their next
   flake. Only orders you would stake a review on.
2. **Choose a branch slug**: `fix/flaky-<short-name>`, unique across orders.
3. **Write `work_order` as a complete brief** a competent engineer with no
   other context acts on: file paths, runnable test id, evidence with numbers,
   root-cause hypothesis, chosen kind AND why, the forbidden-shortcut list,
   and how to verify (which command proves the targeted test, which proves the
   project).
4. **One instance per order.** Never bundle two tests into one order — children
   run in parallel worktrees and cannot share edits.

## Output contract

Structured fields only. The parent fans these out mechanically; each order
becomes one child run's entire world. Nothing outside the declared fields exists.
