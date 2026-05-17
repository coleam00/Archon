---
description: PIV loop — reflect on the completed implementation and produce a structured execution report.
argument-hint: (no arguments — reads plan and implementation artifacts)
---

# PIV Execution Report

**Workflow ID**: $WORKFLOW_ID

The fix has been implemented, validated, reviewed, and the review issues fixed. Before the
system-review phase, reflect deeply on how the run actually went. This report is the primary
input to system-review — be honest and specific.

---

## Phase 1: LOAD

- Read `$ARTIFACTS_DIR/plan.md` — what the agent was supposed to do.
- Read `$ARTIFACTS_DIR/implementation.md` — what the agent did, with divergences.
- Read `$ARTIFACTS_DIR/validation.md` — final validation results.
- Read `$ARTIFACTS_DIR/code-review.md` and `$ARTIFACTS_DIR/code-review-fix.md` — what the
  review caught and what was fixed.
- Run `git diff $BASE_BRANCH...HEAD --stat` for the final change footprint.

### PHASE_1_CHECKPOINT
- [ ] All upstream artifacts loaded
- [ ] Final diff footprint captured

## Phase 2: GENERATE THE REPORT

Write `$ARTIFACTS_DIR/execution-report.md`:

```markdown
# Execution Report

## Meta
- Plan: $ARTIFACTS_DIR/plan.md
- Files added: [paths]
- Files modified: [paths]
- Lines changed: +X -Y

## Validation Results
- Tests: PASS / FAIL [X passed, Y failed]
- Type check: PASS / FAIL [details]
- Lint: PASS / FAIL [details]
- Build / smoke: PASS / FAIL [details]

## What Went Well
- [concrete things that worked smoothly]

## Challenges Encountered
- [what was difficult and why]

## Divergences from the Plan
For each divergence:
**[Title]**
- Planned: [what the plan specified]
- Actual: [what was implemented instead]
- Reason: [why it diverged]
- Type: [Better approach found | Plan assumption wrong | Security concern | Performance issue | Other]

## Issues the Code Review Caught
- [each issue, and whether it points to a planning or execution gap]

## Skipped Items
- [anything from the plan not implemented] — Reason: [why]

## Friction Log
Where did the agent have to guess, search, or backtrack because the AI Layer (CLAUDE.md,
command prompts, references) did not provide what it needed?
- [specific friction point] — [what was missing]

## Recommendations
- AI Layer changes that would have made this run smoother: [specific suggestions]
```

The **Friction Log** and **Recommendations** sections matter most — they are what
system-review turns into AI-Layer improvements. Be concrete.

### PHASE_2_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/execution-report.md` written
- [ ] Divergences documented with type and reason
- [ ] Friction log captures every place the AI Layer fell short

## Phase 3: REPORT

Summarize the run: outcome, key divergences, and the top friction points the AI Layer
should address.
