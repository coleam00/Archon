---
description: Verify that executed code achieves a GSD phase goal and write VERIFICATION.md
argument-hint: <phase number>
---

# GSD Goal Verification

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Verify actual goal achievement from the codebase. Do not trust SUMMARY.md claims without evidence.

## Required process

1. Read `$ARTIFACTS_DIR/phase.txt`.
2. Read `$ARTIFACTS_DIR/phase-evidence.md`.
3. Read relevant PLAN.md, SUMMARY.md, ROADMAP.md, REQUIREMENTS.md, and CONTEXT.md files.
4. Derive must-have truths from roadmap success criteria and PLAN frontmatter.
5. Verify each truth against actual code and behavior evidence.
6. Check artifacts for existence, substance, wiring, and data flow.
7. Scan for stubs, placeholders, empty handlers, mock-only flows, and unwired APIs.
8. Run fast spot-check commands where safe and relevant.
9. Write VERIFICATION.md next to the phase artifacts.
10. Return structured JSON matching the workflow schema.

## Required VERIFICATION.md frontmatter

Include:

- `phase`
- `verified`
- `status`
- `score`
- `gaps` when gaps exist
- `human_verification` when human testing is needed

## Status rules

- `passed`: all must-have truths are verified.
- `gaps_found`: one or more must-have truths fail and can be converted into gap plans.
- `human_needed`: automated checks pass or are inconclusive but human testing is required.

## Final response

Return only JSON with this shape:

```json
{
  "status": "passed",
  "score": "0/0",
  "report_path": ".planning/phases/example/example-VERIFICATION.md",
  "gap_count": 0
}
```
