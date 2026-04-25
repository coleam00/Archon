---
description: Verify design handoff completeness before implementation proceeds
argument-hint: <feature or PRD path>
---

# Design Handoff Check

**Input**: $ARGUMENTS

---

## Mission

Confirm the design handoff is complete enough for implementation and QA.

## Process

1. Read the PRD and design brief artifacts.
2. Check for required flows, states, acceptance notes, copy, and accessibility expectations.
3. Write `$ARTIFACTS_DIR/design/handoff.md`.

## Artifact Format

```markdown
# Design Handoff

## Status

Ready / Ready with caveats / Blocked

## Required Implementation Notes

## Required QA Notes

## Missing Design Inputs

## Approval Recommendation
```

## Output

Return the handoff status and artifact path.
