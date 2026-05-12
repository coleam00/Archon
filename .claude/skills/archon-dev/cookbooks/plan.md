# Plan Cookbook

Detailed implementation plans with codebase intelligence. The most critical cookbook — plans drive everything downstream. Creates a context-rich document that enables one-pass implementation success.

**Input**: `$ARGUMENTS` — path to PRD, feature description, or GitHub issue number.

**Core Principle**: PLAN ONLY — no code written. Codebase first, research second. Solutions must fit existing patterns before introducing new ones.

---

## Phase 0: DETECT — Input Type Resolution

| Input Pattern | Type | Action |
|---------------|------|--------|
| Ends with `.prd.md` | PRD file | Parse PRD, select next phase |
| Ends with `.md` and contains "Implementation Phases" | PRD file | Parse PRD, select next phase |
| File path that exists | Document | Read and extract feature description |
| `#123` or issue number | GitHub issue | Fetch with `gh issue view` |
| Free-form text | Description | Use directly as feature input |

### If PRD File Detected:

1. **Read the PRD file**
2. **Parse the Implementation Phases table** — find rows with `Status: pending`
3. **Check dependencies** — only select phases whose dependencies are `complete`
4. **Select the next actionable phase** — first pending phase with all dependencies complete
5. **Report selection to user**:
   ```
   PRD: {prd file path}
   Selected Phase: #{number} - {name}

   {If parallel phases available:}
   Note: Phase {X} can also run in parallel (in separate worktree).

   Proceeding with Phase #{number}...
   ```

### If Free-form or Issue:
Proceed directly to Phase 1.

**CHECKPOINT**: Input type determined. If PRD: next phase selected and dependencies verified.

---

## Phase 1: PARSE — Feature Understanding

1. **If file path**: Read it as the source document
2. **If GitHub issue**: Fetch with `gh issue view {number}`
3. **If description**: Use it directly
4. **Always read CLAUDE.md** for project conventions, architecture, and constraints

**Extract:**
- Core problem being solved
- User value and business impact
- Feature type: NEW_CAPABILITY | ENHANCEMENT | REFACTOR | BUG_FIX
- Complexity: LOW | MEDIUM | HIGH
- Affected systems list

**Formulate user story:**
```
As a {user type}
I want to {action/goal}
So that {benefit/value}
```

**GATE**: If requirements are AMBIGUOUS, STOP and ASK user for clarification before proceeding.

---

## Phase 2: EXPLORE — Deep Codebase Intelligence

Launch 2-3 agents in parallel using the Agent tool:

### Agent 1: Codebase Explorer (`Explore`)
**Always launch.** Write a detailed prompt asking it to find:
- Similar features already implemented with file:line references
- Naming conventions with actual examples
- Error handling and logging patterns
- Type definitions and test patterns
- Configuration and dependencies

Request actual code snippets — these become the "Patterns to Mirror" section.

### Agent 2: Codebase Analyst (`codebase-analyst`)
**Always launch.** Write a detailed prompt asking it to:
- Map the blast radius — all files that would need to change
- Trace data flow through related components
- Identify entry points and integration contracts
- Document side effects and state changes

### Agent 3: Web Researcher (`web-researcher`)
**Launch only if the feature involves external libraries or APIs.** Ask for version-specific docs (matching package.json versions), known gotchas, migration notes.

### Merge Agent Results

Combine findings into a unified discovery table:

| Category | File:Lines | Pattern Description | Code Snippet |
|----------|-----------|---------------------|--------------|
| NAMING | `path:10-15` | camelCase functions | `export function createThing()` |
| ERRORS | `path:5-20` | Custom error classes | `class ThingNotFoundError` |
| TESTS | `path:1-30` | describe/it blocks | `describe("service", () => {` |

**CHECKPOINT**: Both agents completed. At least 3 similar implementations found. Code snippets are actual (copy-pasted, not invented).

---

## Phase 3: RESEARCH — External Documentation

**ONLY AFTER Phase 2** — solutions must fit existing codebase patterns first.

If web researcher was launched, format findings:

```markdown
- [Library Docs v{version}](https://url#specific-section)
  - KEY_INSIGHT: {what we learned}
  - APPLIES_TO: {which task/file}
  - GOTCHA: {pitfall and how to avoid}
```

**CHECKPOINT**: URLs include specific section anchors. Versions match package.json.

---

## Phase 4: DESIGN — UX Transformation

**Create ASCII diagrams showing user experience before and after:**

```
╔════════════════════════════════════════════════╗
║                  BEFORE STATE                  ║
╠════════════════════════════════════════════════╣
║   USER_FLOW: [current step-by-step]            ║
║   PAIN_POINT: [what's missing or broken]       ║
║   DATA_FLOW: [how data moves currently]        ║
╚════════════════════════════════════════════════╝

╔════════════════════════════════════════════════╗
║                  AFTER STATE                   ║
╠════════════════════════════════════════════════╣
║   USER_FLOW: [new step-by-step]                ║
║   VALUE_ADD: [what user gains]                 ║
║   DATA_FLOW: [how data moves after]            ║
╚════════════════════════════════════════════════╝
```

**Document interaction changes:**

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| {path/component} | {old behavior} | {new behavior} | {what changes} |

**CHECKPOINT**: Before state is accurate. After state shows all new capabilities.

---

## Phase 5: ARCHITECT — Strategic Design

For complex features with multiple integration points, optionally launch a second `codebase-analyst` agent to trace architecture around specific integration points from Phase 2.

**Analyze deeply:**
- ARCHITECTURE_FIT: How does this integrate with existing architecture?
- EXECUTION_ORDER: What must happen first → second → third?
- FAILURE_MODES: Edge cases, race conditions, error scenarios?
- SECURITY: Attack vectors? Data exposure? Auth/authz?

**Decide and document:**

```markdown
APPROACH_CHOSEN: [description]
RATIONALE: [why this over alternatives — reference codebase patterns]

ALTERNATIVES_REJECTED:
- [Alternative 1]: Rejected because [reason]
- [Alternative 2]: Rejected because [reason]

NOT_BUILDING (explicit scope limits):
- [Item 1 — out of scope and why]
- [Item 2 — out of scope and why]
```

---

## Phase 6: VALIDATE — Check Completeness

Before saving, verify:
- [ ] Every file in "Files to Change" actually exists (for UPDATE/DELETE) or parent directory exists (for CREATE)
- [ ] Every pattern cited in "Patterns to Mirror" matches the actual codebase
- [ ] Every task has a clear validation step
- [ ] Acceptance criteria are testable, not vague
- [ ] No circular dependencies between tasks

**NO_PRIOR_KNOWLEDGE_TEST**: Could an agent unfamiliar with this codebase implement using ONLY the plan? If not, add more context.

---

## Phase 7: WRITE — Save Artifact

Save to `.claude/archon/plans/{slug}.plan.md` where `{slug}` is a kebab-case feature name.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Feature: {Title}

## Summary

{1-2 sentences: what changes and why}

## User Story

As {role}
I want {goal}
So that {benefit}

## Problem Statement

{What's wrong today, with evidence — file:line references}

## Solution Statement

{Numbered list of concrete changes}

1. {change 1}
2. {change 2}
3. {change 3}

## Metadata

| Field | Value |
|-------|-------|
| Type | NEW_CAPABILITY / ENHANCEMENT / REFACTOR / BUG_FIX |
| Complexity | LOW / MEDIUM / HIGH |
| Systems Affected | {packages, modules, or areas} |
| Dependencies | {what must exist first} |
| Estimated Tasks | {number} |
| Confidence | {1-10}/10 — {rationale for one-pass implementation success} |

---

## UX Design

### Before State
```
{ASCII diagram — current user experience with data flows}
```

### After State
```
{ASCII diagram — new user experience with data flows}
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| {path/component} | {old behavior} | {new behavior} | {what changes for user} |

---

## NOT Building (Scope Limits)

- {Item 1 — explicitly out of scope and why}
- {Item 2 — explicitly out of scope and why}

---

## Mandatory Reading

**The implementation agent MUST read these files before starting any task.**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `{path}` | {range} | {reason — e.g., "Pattern to MIRROR exactly"} |
| P1 | `{path}` | {range} | {reason — e.g., "Types to IMPORT"} |
| P2 | `{path}` | {range} | {reason — e.g., "Tests to EXTEND"} |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [Lib Docs v{version}](url#anchor) | {section name} | {specific reason} |

## Patterns to Mirror

**Copy these patterns from the existing codebase.**

**{PATTERN_NAME}:**
\`\`\`{language}
// SOURCE: {file}:{lines}
{actual code snippet from the codebase}
\`\`\`

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `{path}` | CREATE | {why} |
| `{path}` | UPDATE | {why} |
| `{path}` | DELETE | {why} |

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: {ACTION} `{file path}`

**Action**: CREATE / UPDATE / DELETE
**Details**: {Exact changes with code snippets where helpful}
**Mirror**: `{source file}:{lines}` — follow this pattern
**Imports**: {specific imports needed}
**Gotcha**: {known issue to avoid}
**Validate**: `{specific command to verify this task}`

### Task 2: {ACTION} `{file path}`

...

---

## Testing Strategy

### Tests to Write

| Test File | Test Cases | Validates |
|-----------|-----------|-----------|
| `{path}` | {cases} | {what} |

### Edge Cases Checklist

- [ ] {edge case 1}
- [ ] {edge case 2}
- [ ] {feature-specific edge case}

---

## Validation Commands

**Detect project runner**:
- `bun.lockb` → bun
- `pnpm-lock.yaml` → pnpm
- `yarn.lock` → yarn
- else → npm

**Levels:**

1. **Type check**: `{runner} run type-check`
2. **Lint**: `{runner} run lint`
3. **Unit tests**: `{runner} run test` (or specific test file)
4. **Full validation**: `{runner} run validate` (if available)
5. **Database validation**: {if schema changes — verify tables, indexes}
6. **Manual verification**: {specific curl, CLI, or browser commands}

## Acceptance Criteria

- [ ] {criterion 1 — specific and testable}
- [ ] {criterion 2}
- [ ] All validation commands pass
- [ ] No regressions in existing tests

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {risk} | Low/Med/High | Low/Med/High | {specific mitigation} |
```

---

## Phase 8: REPORT — Present and Suggest Next Step

Summarize the plan:

```markdown
## Plan Created

**File**: `.claude/archon/plans/{slug}.plan.md`

{If from PRD:}
**Source PRD**: `{prd-file-path}`
**Phase**: #{number} - {phase name}

**Summary**: {2-3 sentence feature overview}
**Complexity**: {LOW/MEDIUM/HIGH} — {rationale}
**Confidence**: {1-10}/10 for one-pass implementation

**Scope**:
- {N} files to CREATE
- {M} files to UPDATE
- {K} total tasks

**Key Patterns**: {top 2-3 from codebase with file:line}
**UX**: BEFORE: {one-line} → AFTER: {one-line}
**Risks**: {primary risk}: {mitigation}

{If parallel phases available:}
**Parallel Opportunity**: Phase {X} can run concurrently in a separate worktree.

**Next Step**: `/archon-dev implement .claude/archon/plans/{slug}.plan.md`
```

**If input was from a PRD file**, also update the PRD:
1. Change the phase's Status from `pending` to `in-progress`
2. Add the plan file path to the Plan column
