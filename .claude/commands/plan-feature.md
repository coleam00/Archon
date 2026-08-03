---
description: Create a comprehensive implementation plan for an Archon feature
argument-hint: <feature-name-or-description>
---

# Plan Feature: Comprehensive Archon Implementation Planning

## Objective

Produce a detailed, actionable implementation plan for: **$ARGUMENTS**

The plan will be saved to `.claude/archon/plans/{kebab-case-name}.md` and is designed to be
consumed by the `/execute` command.

---

## Phase 1: Feature Understanding

Restate the feature request in your own words. Identify:

1. **Problem being solved** — What user pain point or capability gap does this address?
2. **Success criteria** — What does "done" look like? How will we verify it works?
3. **Scope boundaries** — What is explicitly in scope vs. out of scope?
4. **Package impact** — Which of the 8 packages are affected? (`paths`, `git`, `isolation`,
   `workflows`, `core`, `adapters`, `server`, `web`)
5. **Interface changes** — Does this touch `IPlatformAdapter`, `IAgentProvider`,
   `IDatabase`, or `IWorkflowStore`? New interfaces needed?

---

## Phase 2: Codebase Intelligence

Use subagents to perform targeted codebase research in parallel. Spawn separate subagents for:

**Subagent A — Affected package deep-dive:**
Read all relevant source files in the affected packages. Map the current data flow.
Identify every file that will need to change.

**Subagent B — Interface and type contracts:**
Read `packages/core/src/types/` and relevant `index.ts` exports. Understand what interfaces
exist and how they're consumed across packages.

**Subagent C — Test patterns:**
Find existing test files similar to the area of change:

```bash
find packages/ -name "*.test.ts" | head -30
```

Read 2-3 representative test files to understand mocking patterns, assertion style, and
`mock.module()` isolation requirements per package.

**Subagent D — Related prior work:**
```bash
git log --oneline --all | head -20
```
Read recent commits touching relevant files to understand change patterns.

Synthesize findings: current state, gaps, constraints.

---

## Phase 3: External Research (if needed)

If the feature involves external APIs, new libraries, or unfamiliar patterns, use web search
to research:

- Relevant SDK documentation
- Known gotchas or version incompatibilities
- Community patterns for the problem domain

Document any specific findings that affect the implementation approach.

---

## Phase 4: Strategic Thinking

Before writing tasks, reason through:

**Architecture decisions:**
- Where does this logic belong? Apply SRP — keep each module focused on one concern.
- Does this require a new package, or extends an existing one?
- What's the dependency direction? Never create circular deps (paths ← git ← isolation/workflows ← core ← adapters ← server).

**Interface design:**
- Prefer extending existing narrow interfaces over creating fat ones.
- New interface methods only if they have a concrete current caller.
- Avoid adding methods to `IPlatformAdapter` or `IAgentProvider` unless essential.

**Test isolation strategy:**
- `mock.module()` is process-global and permanent in Bun — plan test file placement carefully.
- If adding tests to packages with split test batches (core, workflows, adapters, isolation),
  determine which batch the new test belongs to.

**ESLint compliance:**
- All new functions need explicit return types.
- No `any` without justification.
- Zero-warning policy enforced in CI.

**Rollback plan:**
- What is the blast radius if this goes wrong?
- Are changes reversible without a DB migration?

---

## Phase 5: Plan Generation

Generate the implementation plan at `.claude/archon/plans/{kebab-case-feature-name}.md`:

```markdown
# Plan: {Feature Name}

## Overview
{1-2 sentence summary of what this implements and why.}

## Success Criteria
- [ ] {Verifiable criterion 1}
- [ ] {Verifiable criterion 2}
- [ ] Passes `bun run validate` (type-check + lint + format + tests)

## Affected Packages
- `@archon/{package}` — {what changes}

## Architecture Notes
{Key decisions, tradeoffs, interface changes.}

## Implementation Tasks

### Task 1: {descriptive name}
**File:** `packages/{package}/src/{file}.ts`
**Type:** Create | Modify | Delete
**Description:** {What this task does and why.}
**Depends on:** {Task N, or "none"}

### Task 2: ...

## Validation Steps
1. `bun run type-check` — must pass with zero errors
2. `bun run lint` — must pass with zero warnings
3. `bun run format:check` — must pass
4. `bun run test` — must pass (run via `bun --filter '*' test` for isolation)
5. Manual test: {specific curl command or UI steps to verify the feature}

## Rollback Notes
{How to safely revert if needed.}
```

### Task Ordering Rules
- Order by dependency (blocked tasks come after their dependencies).
- Group by package when possible to minimize context switching.
- Database schema changes (if any) come first.
- Type/interface definitions before implementations.
- Tests after implementations.
- Frontend after backend API is stable.

### Prohibited Patterns (flag in plan if you see a risk)
- `import * as core from '@archon/core'` — use named imports
- `any` type without justification comment
- Circular package dependencies
- `git clean -fd` in any script or test
- `bun test` from repo root (use `bun run test` or `bun --filter '*' test`)

---

## Output

1. Save the plan file to `.claude/archon/plans/{kebab-case-name}.md`
2. Print the plan to the conversation
3. Summarize: number of tasks, affected packages, estimated complexity (low/medium/high),
   and any risks or open questions that need resolution before execution.
