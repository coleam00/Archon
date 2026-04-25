---
description: Convert an approved PRD into a design brief and UX handoff plan
argument-hint: <prd path or feature description>
---

# Design Brief

**Input**: $ARGUMENTS

---

## Mission

Create a design brief that gives implementation and QA enough context to build and validate the user experience.

## Process

1. Read `$ARTIFACTS_DIR/product/prd.md` if present.
2. Inspect existing UI patterns, components, routes, and accessibility conventions.
3. Identify required user flows, states, copy, errors, empty states, and permissions.
4. Write `$ARTIFACTS_DIR/design/design-brief.md`.

## Artifact Format

```markdown
# Design Brief

## UX Goal

## Primary User Flow

## Secondary Flows

## States

- Loading:
- Empty:
- Error:
- Permission denied:
- Success:

## Interaction Requirements

## Accessibility Requirements

## Existing Patterns To Reuse

## Open Design Questions

## Handoff Checklist
```

## Output

Return the artifact path and any design blockers.
