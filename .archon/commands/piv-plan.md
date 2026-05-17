---
description: PIV loop — turn the primed task into a comprehensive, one-pass-ready implementation plan.
argument-hint: (no arguments — reads the primer and review notes from workflow artifacts)
---

# PIV Plan: Create the Implementation Plan

**Workflow ID**: $WORKFLOW_ID

Transform the primed task into a **comprehensive implementation plan**. We do NOT write code
in this phase. The goal is a context-rich plan that lets the implementation agent succeed in
one pass.

**Core principle**: Context is King. The plan must contain everything the execution agent
needs — patterns, mandatory reading, validation commands — so it never has to guess.

---

## Phase 1: LOAD

- Read `$ARTIFACTS_DIR/prime.md` — the task definition and codebase primer.
- Read `$ARTIFACTS_DIR/prime-review.md` if it exists — the human's corrections and direction
  from the prime-review gate. **These corrections override the primer where they conflict.**
- Re-read `CLAUDE.md` and any files the plan will change — verify the primer is still current.

### PHASE_1_CHECKPOINT
- [ ] Primer loaded
- [ ] Human review notes loaded and reconciled with the primer

## Phase 2: ANALYZE

**Feature understanding** — extract the core problem, the user value, the feature type
(New Capability / Enhancement / Refactor / Bug Fix), and complexity (Low / Medium / High).

**Codebase intelligence** — confirm and deepen the primer:
- Patterns to mirror: naming, file organization, error handling, logging.
- Dependency analysis: relevant libraries and how they are integrated.
- Testing patterns: framework, structure, a similar test to use as a reference.
- Integration points: existing files to update, new files to create, registration patterns.

**External research** (only if genuinely needed) — official docs for any unfamiliar library,
known gotchas, breaking changes. Cite URLs with section anchors.

**ESLint constraint verification** — when the plan will recommend a specific TypeScript
construct in a GOTCHA (type assertion `as T`, non-null assertion `!`, `satisfies`, etc.),
verify it is compatible with the project's `@typescript-eslint/*` rules before writing the
GOTCHA. Check `eslint.config.*` or the `eslintConfig` in `package.json` for relevant rules.
In Archon specifically: `@typescript-eslint/non-nullable-type-assertion-style` and
`@typescript-eslint/no-non-null-assertion` together rule out both `as string` and `!` — the
correct resolution is a `?? fallback` with an inline comment explaining the invariant.

### PHASE_2_CHECKPOINT
- [ ] Feature type and complexity assessed
- [ ] Patterns, dependencies, testing approach, and integration points documented
- [ ] Ambiguities resolved (or escalated for the plan-review gate)

## Phase 3: GENERATE THE PLAN

Write the plan to `$ARTIFACTS_DIR/plan.md` using this template. Fill EVERY section with
specific, verified information — no generic placeholders.

```markdown
# Feature: <feature-name>

## Summary
<1-2 sentences: what changes and why>

## Problem Statement
<the specific problem or opportunity this addresses>

## Solution Statement
<the proposed approach and how it solves the problem>

## Metadata
- Feature Type: [New Capability / Enhancement / Refactor / Bug Fix]
- Complexity: [Low / Medium / High]
- Primary Systems Affected: [components / services]

## Context References

### Files to Read Before Implementing
- `path/to/file` (lines X-Y) — Why: contains the pattern to mirror
- `path/to/test` — Why: test pattern example

### New Files to Create
- `path/to/new_file` — purpose

### Relevant Documentation
- [Doc title](url#section) — Why: needed for X

### Patterns to Follow
<actual code snippets from this codebase to mirror — naming, error handling, logging>

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.
Use information-dense action keywords: CREATE / UPDATE / ADD / REMOVE / REFACTOR / MIRROR.

### Task 1: {ACTION} `{file path}`
- IMPLEMENT: {specific change — detailed enough for an agent with no prior context}
- PATTERN: {reference file:line to mirror}
- IMPORTS: {required imports}
- GOTCHA: {known constraint to avoid}
- VALIDATE: `{executable command that verifies this task}`

<continue with all tasks in dependency order>

## Testing Strategy
| Test File | Test Cases | Validates |
|-----------|-----------|-----------|
| `{path}` | {cases} | {what} |

> When a test file is in a different package from the code under test, add one sentence
> explaining why (e.g., "these tests live in `dag-executor.test.ts` because that file
> already has the `loadMcpConfig` import group — adding a new test file in `@archon/providers`
> would require a new test batch in its `package.json`").

## Validation Commands
1. Syntax / lint: `{command}`
2. Type check: `{command}`
3. Tests: `{command}`
4. Full validation: `{command}`

## Acceptance Criteria
- [ ] {specific, testable criterion}
- [ ] All validation commands pass with zero errors
- [ ] No regressions in existing tests

## Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| {risk} | HIGH/MED/LOW | {mitigation} |
```

## Phase 4: VERIFY

- Every file path referenced — confirm it exists.
- Every pattern cited — confirm the code matches.
- Task ordering — dependencies respected.
- Completeness — could an agent with NO prior context implement this from the plan alone?
- Any GOTCHA that recommends a TypeScript construct — confirmed it passes `bun run lint`.

### PHASE_4_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/plan.md` written
- [ ] All file paths and patterns verified
- [ ] Every task has an executable validation command

## Phase 5: REPORT

Output a summary for the human reviewing this phase:
- The feature and approach
- Task count and files-to-change count
- Key decisions made
- A confidence score (#/10) for one-pass implementation success

Tell the human: the plan-review gate is next — they can edit the plan, add or remove tasks,
or approve to begin implementation.
