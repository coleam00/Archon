---
description: "Create comprehensive implementation plan with codebase analysis and research"
argument-hint: "<feature description | path/to/prd.md>"
agent: "agent"
tools:
  - agent
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - usages
  - listDirectory
  - runInTerminal
  - createFile
  - createDirectory
  - editFiles
agents:
  - codebase-explorer
  - codebase-analyst
  - web-researcher
---

# Implementation Plan Generator

**Input**: ${input:feature:Feature description or path to PRD file}

## Objective

Transform the input into a battle-tested implementation plan through systematic codebase exploration, pattern extraction, and strategic research.

**Core Principle**: PLAN ONLY - no code written. Create a context-rich document that enables one-pass implementation success.

**Execution Order**: CODEBASE FIRST, RESEARCH SECOND. Solutions must fit existing patterns before introducing new ones.

**Agent Strategy**: Use specialized subagents for intelligence gathering:

- `codebase-explorer` — finds WHERE code lives and extracts implementation patterns
- `codebase-analyst` — analyzes HOW integration points work and traces data flow
- `web-researcher` — strategic web research with citations and gap analysis

Launch codebase agents in parallel first, then research agent second.

---

## Phase 0: DETECT - Input Type Resolution

### Determine Input Type

| Input Pattern | Type | Action |
|---------------|------|--------|
| Ends with `.prd.md` | PRD file | Parse PRD, select next pending phase |
| Ends with `.md` and contains "Implementation Phases" | PRD file | Parse PRD, select next pending phase |
| File path that exists | Document | Read and extract feature description |
| Free-form text | Description | Use directly as feature input |
| Empty/blank | Conversation | Use conversation context as input |

### If PRD File Detected

1. Read the PRD file
2. Parse the Implementation Phases table - find rows with `Status: pending`
3. Check dependencies - only select phases whose dependencies are `complete`
4. Select the next actionable phase (first pending with all dependencies complete)
5. Extract phase context:

```
PHASE: {phase number and name}
GOAL: {from phase details}
SCOPE: {from phase details}
PRD CONTEXT: {problem statement, user, hypothesis from PRD}
```

6. Report selection to user before proceeding

### If Free-form or Conversation Context

Proceed directly to Phase 1 with the input as feature description.

---

## Phase 1: PARSE - Feature Understanding

### Discover Project Structure

**IMPORTANT**: Do NOT assume `src/` exists. Run these first:

```bash
ls -la
ls -la */ 2>/dev/null | head -50
```

Common alternatives:
- `app/` (Next.js, Rails, Laravel)
- `lib/` (Ruby gems, Elixir)
- `packages/` (monorepos)
- `cmd/`, `internal/`, `pkg/` (Go)
- Root-level source files (Python, scripts)

Identify project type from config files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.)

### Extract Feature Understanding

- **Problem**: What are we solving? Must be specific and testable.
- **User Story**: As a [user], I want to [action], so that [benefit]
- **Type**: NEW_CAPABILITY / ENHANCEMENT / REFACTOR / BUG_FIX
- **Complexity**: LOW / MEDIUM / HIGH (with rationale)
- **Affected Systems**: Which parts of the codebase are touched?

**GATE**: If requirements are AMBIGUOUS, STOP and ASK the user for clarification before proceeding.

---

## Phase 2: EXPLORE - Codebase Intelligence

**CRITICAL: Use the `codebase-explorer` and `codebase-analyst` subagents in parallel.**

### Subagent: codebase-explorer

Finds WHERE code lives and extracts implementation patterns.

```
Find all code relevant to implementing: {feature description}.

LOCATE:
1. Similar implementations - analogous features with file:line references
2. Naming conventions - actual examples of function/class/file naming
3. Error handling patterns - how errors are created, thrown, caught
4. Logging patterns - logger usage, message formats
5. Type definitions - relevant interfaces and types
6. Test patterns - test file structure, assertion styles, test file locations
7. Configuration - relevant config files and settings
8. Dependencies - relevant libraries already in use

Categorize findings by purpose (implementation, tests, config, types, docs).
Return ACTUAL code snippets from codebase, not generic examples.
```

### Subagent: codebase-analyst

Analyzes HOW integration points work and traces data flow.

```
Analyze the implementation details relevant to: {feature description}.

TRACE:
1. Entry points - where new code will connect to existing code
2. Data flow - how data moves through related components
3. State changes - side effects in related functions
4. Contracts - interfaces and expectations between components
5. Patterns in use - design patterns and architectural decisions

Document what exists with precise file:line references. No suggestions or improvements.
```

### Merge Agent Results

Combine findings from both agents into a unified discovery table:

| Category | File:Lines | Pattern Description | Code Snippet |
|----------|------------|---------------------|--------------|
| NAMING | `src/features/X/service.ts:10-15` | {convention} | {actual code} |
| ERRORS | `src/features/X/errors.ts:5-20` | {pattern} | {actual code} |
| TYPES | `src/features/X/models.ts:1-20` | {pattern} | {actual code} |
| TESTS | `src/features/X/tests/service.test.ts:1-30` | {pattern} | {actual code} |
| FLOW | `src/features/X/service.ts:40-60` | {transformation} | {actual code} |

**Checkpoint:**

- [ ] Both subagents launched in parallel and completed
- [ ] At least 3 similar implementations found with file:line references
- [ ] Code snippets are ACTUAL (copy-pasted from codebase, not invented)
- [ ] Integration points mapped with data flow traces
- [ ] Dependencies cataloged with versions

---

## Phase 3: RESEARCH - External Documentation

**ONLY AFTER Phase 2 is complete** - solutions must fit existing codebase patterns first.

### Subagent: web-researcher

```
Research external documentation relevant to implementing: {feature description}.

FIND:
1. Official documentation for involved libraries (match versions from project config)
2. Known gotchas, breaking changes, deprecations for these versions
3. Security considerations and best practices
4. Performance optimization patterns

VERSION CONSTRAINTS:
- {library}: v{version} (from package.json / pyproject.toml / etc.)

Return findings with:
- Direct links to specific doc sections (not just homepages)
- Key insights that affect implementation
- Gotchas with mitigation strategies
- Any conflicts between docs and existing codebase patterns found in Phase 2
```

### Format Research into Plan References

```markdown
- [{Library} Docs v{version}]({url}#{specific-section})
  - KEY_INSIGHT: {what we learned that affects implementation}
  - APPLIES_TO: {which task/file this affects}
  - GOTCHA: {potential pitfall and how to avoid}
```

**Checkpoint:**

- [ ] Documentation versions match project config
- [ ] URLs include specific section anchors (not just homepages)
- [ ] Gotchas documented with mitigation strategies
- [ ] No conflicting patterns between external docs and existing codebase

---

## Phase 4: DESIGN - UX Transformation

**Create ASCII diagrams showing the user experience before and after:**

```
BEFORE STATE:

  [Screen/Component] --> [Current Action] --> [Current Result]

  USER_FLOW: {describe current step-by-step experience}
  PAIN_POINT: {what's missing, broken, or inefficient}
  DATA_FLOW: {how data moves through the system currently}


AFTER STATE:

  [Screen/Component] --> [New Action] --> [New Result]
                              |
                              v
                        [New Capability]

  USER_FLOW: {describe new step-by-step experience}
  VALUE_ADD: {what user gains from this change}
  DATA_FLOW: {how data moves through the system after}
```

### Interaction Changes

| Location | Before | After | User Action | Impact |
|----------|--------|-------|-------------|--------|
| {path/component} | {old behavior} | {new behavior} | {what user does} | {what changes} |

**Checkpoint:**

- [ ] Before state accurately reflects current system behavior
- [ ] After state shows ALL new capabilities
- [ ] Data flows are traceable from input to output
- [ ] User value is explicit and measurable

---

## Phase 5: ARCHITECT - Strategic Design

**For complex features**, use the `codebase-analyst` subagent to trace architecture at integration points identified in Phase 2:

```
Analyze the architecture around these integration points for: {feature description}.

INTEGRATION POINTS (from Phase 2):
- {entry point 1}
- {entry point 2}

ANALYZE:
1. How data flows through each integration point
2. What contracts exist between components
3. What side effects occur at each stage
4. What error handling patterns are in place

Document what exists with precise file:line references. No suggestions.
```

### Analyze Deeply

- **Architecture Fit**: How does this integrate with the existing architecture?
- **Execution Order**: What must happen first, second, third?
- **Failure Modes**: Edge cases, race conditions, error scenarios?
- **Performance**: Will this scale? Database queries optimized?
- **Security**: Attack vectors? Data exposure risks? Auth/authz?

### Document Decisions

```markdown
APPROACH: {description}
RATIONALE: {why this over alternatives - reference codebase patterns}

ALTERNATIVES REJECTED:
- {Alternative 1}: Rejected because {specific reason}
- {Alternative 2}: Rejected because {specific reason}

NOT BUILDING (explicit scope limits):
- {Item 1 - explicitly out of scope and why}
- {Item 2 - explicitly out of scope and why}
```

**Checkpoint:**

- [ ] Approach aligns with existing architecture and patterns
- [ ] Dependencies ordered correctly
- [ ] Edge cases identified with specific mitigation strategies
- [ ] Scope boundaries are explicit and justified

---

## Phase 6: GENERATE - Implementation Plan File

### Create Plan File

**Output path**: `.agents/plans/{kebab-case-name}.plan.md`

```bash
mkdir -p .agents/plans
```

Write this structure to the plan file:

````markdown
# Plan: {Feature Name}

## Summary

{One paragraph: What we're building and high-level approach}

## User Story

As a {user type}
I want to {action}
So that {benefit}

## Problem Statement

{Specific problem this solves - must be testable}

## Metadata

| Field | Value |
|-------|-------|
| Type | {NEW_CAPABILITY / ENHANCEMENT / REFACTOR / BUG_FIX} |
| Complexity | {LOW / MEDIUM / HIGH} |
| Systems Affected | {comma-separated list} |
| Dependencies | {external libs/services with versions} |
| Estimated Tasks | {count} |

---

## UX Design

### Before State

```
{ASCII diagram - current user experience with data flows}
```

### After State

```
{ASCII diagram - new user experience with data flows}
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| {path/component} | {old behavior} | {new behavior} | {what changes for user} |

---

## Mandatory Reading

**Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `path/to/critical.ts` | 10-50 | Pattern to MIRROR exactly |
| P1 | `path/to/types.ts` | 1-30 | Types to IMPORT |
| P2 | `path/to/test.ts` | all | Test pattern to FOLLOW |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [{Lib} Docs v{version}]({url}#{anchor}) | {section name} | {specific reason} |

---

## Patterns to Mirror

**From codebase - copy these patterns exactly:**

### Naming Convention

```
// SOURCE: {file:lines}
{actual code snippet from codebase}
```

### Error Handling

```
// SOURCE: {file:lines}
{actual code snippet from codebase}
```

### Service/Business Logic

```
// SOURCE: {file:lines}
{actual code snippet from codebase}
```

### Tests

```
// SOURCE: {file:lines}
{actual code snippet from codebase}
```

---

## Files to Change

| File | Action | Purpose |
|------|--------|---------|
| `path/to/file` | CREATE | {why} |
| `path/to/other` | UPDATE | {why} |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- {Item 1 - explicitly out of scope and why}
- {Item 2 - explicitly out of scope and why}

---

## Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: {Description}

- **File**: `path/to/file`
- **Action**: CREATE / UPDATE
- **Implement**: {specific what to do}
- **Mirror**: `path/to/example:lines` - follow this pattern
- **Imports**: {key imports needed}
- **Gotcha**: {known issue to avoid}
- **Validate**: `{build/type-check command}`

### Task 2: {Description}

- **File**: `path/to/file`
- **Action**: CREATE / UPDATE
- **Implement**: {specific what to do}
- **Mirror**: `path/to/example:lines`
- **Validate**: `{build/type-check command}`

{Continue for each task...}

### Task N: Add/Update Tests

- **File**: `path/to/test`
- **Action**: CREATE / UPDATE
- **Implement**: Test each function, happy path + error cases
- **Mirror**: `path/to/existing-test:lines`
- **Validate**: `{test command}`

---

## Testing Strategy

### Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `path/to/test` | valid input, invalid input | Schema validation |
| `path/to/test` | CRUD ops, access control | Business logic |

### Edge Cases Checklist

- [ ] Empty string inputs
- [ ] Missing required fields
- [ ] Unauthorized access attempts
- [ ] Not found scenarios
- [ ] Duplicate creation attempts
- [ ] {feature-specific edge case}

---

## Validation

### Static Analysis

```bash
# Adapt to project's toolchain
{runner} run build       # Type check
{runner} run lint        # Lint
```

### Tests

```bash
{runner} test {path/to/feature/tests}
```

### Full Suite

```bash
{runner} test && {runner} run build
```

### Manual Verification

1. {Step to verify the feature works}
2. {Step to verify no regression}

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {risk} | LOW/MED/HIGH | LOW/MED/HIGH | {strategy} |

---

## Acceptance Criteria

- [ ] All tasks completed in dependency order
- [ ] Type check passes
- [ ] Lint passes
- [ ] Tests pass (new + existing)
- [ ] Code mirrors existing patterns exactly
- [ ] UX matches "After State" diagram
- [ ] No regressions in existing tests
````

---

## Phase 7: VERIFY - Plan Quality Check

Before saving, verify the plan against these criteria:

**Context Completeness:**

- [ ] All patterns from subagents documented with file:line references
- [ ] External docs versioned to match project config
- [ ] Integration points mapped with specific file paths
- [ ] Gotchas captured with mitigation strategies
- [ ] Every task has at least one executable validation command

**Implementation Readiness:**

- [ ] Tasks ordered by dependency (can execute top-to-bottom)
- [ ] Each task is atomic and independently testable
- [ ] No placeholders - all content is specific and actionable
- [ ] Pattern references include actual code snippets (copy-pasted, not invented)

**Pattern Faithfulness:**

- [ ] Every new file mirrors existing codebase style exactly
- [ ] No unnecessary abstractions introduced
- [ ] Naming follows discovered conventions
- [ ] Error/logging patterns match existing
- [ ] Test structure matches existing tests

**One-Pass Test:** Could an agent unfamiliar with this codebase implement using ONLY the plan?

---

## Phase 8: OUTPUT

### If Input Was From PRD File

Update the PRD:

1. Change the selected phase's Status from `pending` to `in-progress`
2. Add the plan file path to the phase row

### Report to User

```markdown
## Plan Created

**File**: `.agents/plans/{name}.plan.md`

{If from PRD:}
**Source PRD**: `{prd-file-path}`
**Phase**: #{number} - {phase name}
**PRD Updated**: Status set to `in-progress`, plan linked

**Summary**: {2-3 sentence overview}

**Complexity**: {LOW/MEDIUM/HIGH} - {brief rationale}

**Scope**:
- {N} files to CREATE
- {M} files to UPDATE
- {K} total tasks

**Key Patterns Discovered**:
- {Pattern 1 from codebase-explorer with file:line}
- {Pattern 2 from codebase-analyst with file:line}

**External Research**:
- {Key doc 1 with version}
- {Key doc 2 with version}

**UX Transformation**:
- BEFORE: {one-line current state}
- AFTER: {one-line new state}

**Risks**:
- {Primary risk}: {mitigation}

**Confidence**: {1-10}/10 for one-pass implementation success
- {Rationale for score}

**Next Step**: Review the plan, then: `/implement .agents/plans/{name}.plan.md`
```
