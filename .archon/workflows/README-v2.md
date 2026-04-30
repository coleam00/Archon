# Archon v2 Workflows — Side-by-Side Test Bench

This directory contains v2 forks of two Archon workflows, designed to fix the
quality issues observed in the Memexia audit (2026-04-30). The originals live
under `.archon/workflows/defaults/` (bundled) and continue to work unchanged.

## What's in v2

| File | Purpose |
|------|---------|
| `archon-comprehensive-pr-review-v2.yaml` | PR review workflow (review any PR, including human-authored) |
| `archon-fix-github-issue-v2.yaml` | Issue-fix workflow (Archon creates the PR + reviews itself) |
| `../commands/archon-code-review-agent-v2.md` | Reviewer — emits `findings.json` (v2 contract) |
| `../commands/archon-error-handling-agent-v2.md` | " |
| `../commands/archon-test-coverage-agent-v2.md` | " |
| `../commands/archon-comment-quality-agent-v2.md` | " |
| `../commands/archon-docs-impact-agent-v2.md` | " |
| `../commands/archon-synthesize-review-v2.md` | Aggregates JSON findings → `synthesis.json` |
| `../commands/archon-self-fix-all-v2.md` | Reads synthesis.json, fixes, emits `fix-report.json` |
| `../commands/archon-implement-review-fixes-v2.md` | Comprehensive-PR-review counterpart of self-fix |

## What changed vs v1

### 1. Structured JSON contract between every node

Every reviewer now emits **two** artifacts:
- The original markdown (kept for human reading; pipeline ignores it)
- A new `<agent>-findings.json` with severity, file:line, evidence, recommended_fix, and a `confirmation_check` bash command

`synthesize-v2` reads those JSONs and writes `synthesis.json` with `blocking_findings`, `stats`, and a `verdict` field.

`self-fix-v2` / `implement-review-fixes-v2` consume `synthesis.json` (not English markdown) and emit `fix-report.json` recording status per finding.

### 2. Hard CRITICAL gate

After `synthesize` and again after `re-review`, a bash node reads the JSON and exits non-zero if blocking findings remain. The workflow stops; the PR is reverted to draft and a comment is posted.

### 3. Re-review verification loop

After `self-fix` runs once, a `loop:` node re-runs the verification: for each blocking finding, run its `confirmation_check`; check whether the fix addressed root cause or just symptom; flag any newly-introduced findings. Caps at 2 iterations.

This is the single biggest functional change — the v1 pipeline trusts the agent that wrote the fix to verify it. v2 doesn't.

### 4. `trigger_rule: one_success` → `all_done`

Was: synthesize fires when at least one reviewer succeeds (so 4 of 5 reviewers can fail and self-fix runs against partial findings).

Now: synthesize waits for all reviewers, tolerates failures, and the pre-fix-gate enforces a minimum of 2-3 reviewers before continuing.

### 5. Read-only reviewers

Every reviewer node has `denied_tools: [Edit, Write, Bash]`. Reviewers cannot accidentally modify the code they're reviewing.

### 6. `set -euo pipefail` in every bash node

A consistent source of silent failures in the original ship-* workflows was bash exit codes being ignored. v2 enforces strict mode.

### 7. fix-github-issue-v2 only: extra gates

- `dedup-check` — before classifying, check if the issue already has a merged PR and abort if so. Would have caught the PR #40 / #23 duplicate in Memexia.
- `plan-confidence-gate` — read the plan's self-rated Confidence Score and abort if < 7.
- `validate-gate` — after the AI's `archon-validate` node, run the project's own `validate` script as a hard gate before PR creation. Type-check alone is insufficient.

## How to run side-by-side

The originals are under `.archon/workflows/defaults/` (bundled defaults).
The v2s are under `.archon/workflows/` (project-level), which the loader
discovers automatically.

```bash
# v1 (unchanged)
archon workflow run archon-fix-github-issue --branch fix/issue-100-v1 "Fix #100"

# v2 (new)
archon workflow run archon-fix-github-issue-v2 --branch fix/issue-100-v2 "Fix #100"
```

Run them on the same issue from different worktrees to compare:
- Diff size at PR creation time
- Number of "Address review findings" follow-up commits needed
- Number of human review comments after the workflow finishes
- Number of regressions caught by the post-fix gate vs landing in main

## Bundle these into defaults later

When v2 is validated against several real issues, regenerate bundled defaults:

```bash
# Move v2 files from .archon/workflows/ → .archon/workflows/defaults/
# Move v2 commands from .archon/commands/ → .archon/commands/defaults/
mv .archon/workflows/archon-{fix-github-issue,comprehensive-pr-review}-v2.yaml \
   .archon/workflows/defaults/
mv .archon/commands/archon-*-v2.md \
   .archon/commands/defaults/

# Regenerate the embedded bundle
bun run generate:bundled

# Optional: drop the v2 suffix once you're happy and the originals are retired
```

## Open questions / known gaps

- **`output_format` schema**: v2 reviewers emit JSON via filesystem, not via Archon's
  `output_format` (which would route through SDK structured output). The reason is the
  reviewers also write a markdown artifact — the SDK's `output_format` is one-shot.
  If desired, a future v3 could split each reviewer into two nodes: one structured-
  output classifier + one prose-writer, but the current shape is simpler.

- **Plan-confidence parsing**: the gate greps for "Confidence Score: N/10". The
  plan template in `archon-create-plan.md` writes this format consistently, but if
  the AI deviates, the gate logs a WARN and proceeds. Consider tightening to fail-
  closed once you've observed several runs.

- **`gh pr ready --undo`**: the post-fix gate reverts the PR to draft. If the PR
  was already in draft, this is a no-op. If the PR was marked ready by the human
  who triggered the workflow, this overrides their state. That's intentional —
  blocking findings shouldn't ship — but worth knowing.

- **Re-review can hit max_iterations with findings still unresolved**. In that
  case the post-fix-gate exits non-zero, the PR stays draft, and the human takes
  over. There is no automatic rollback of the v2 fixes.
