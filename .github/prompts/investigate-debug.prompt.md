---
description: "Investigate a GitHub issue or problem - analyze codebase, create plan, post to GitHub"
argument-hint: "<issue-number | url | problem description>"
agent: "agent"
tools:
  - agent
  - codebase
  - readFile
  - textSearch
  - fileSearch
  - usages
  - runInTerminal
  - editFiles
  - createFile
  - createDirectory
  - problems
agents:
  - codebase-explorer
  - codebase-analyst
---

# Investigate Issue

**Input**: ${input:issue:GitHub issue number, URL, or problem description}

---

## Your Mission

Investigate the issue/problem and produce a comprehensive implementation plan that:

1. Can be executed by `/implement-fix`
2. Is posted as a GitHub comment (if GH issue provided)
3. Captures all context needed for one-pass implementation

**Golden Rule**: The artifact you produce IS the specification. The implementing agent should be able to work from it without asking questions.

---

## Phase 1: PARSE - Understand Input

### 1.1 Determine Input Type

| Input | Example | Action |
|-------|---------|--------|
| Issue number | `123`, `#123` | Fetch with `gh issue view` |
| URL | `github.com/.../issues/123` | Extract number, fetch |
| Free-form text | anything else | Use as problem description |
| Blank | (none) | Use conversation context |

**If GitHub issue:**

```bash
gh issue view {number} --json title,body,labels,comments,state,url,author
```

### 1.2 Extract Context

**If GitHub issue:**

- Title: What's the reported problem?
- Body: Details, reproduction steps, expected vs actual
- Labels: bug? enhancement? documentation?
- Comments: Additional context from discussion
- State: Is it still open?

**If free-form:**

- Parse as problem description
- Note: No GitHub posting (artifact only)

### 1.3 Classify Issue Type

| Type | Indicators |
|------|------------|
| BUG | "broken", "error", "crash", "doesn't work", stack trace |
| ENHANCEMENT | "add", "support", "feature", "would be nice" |
| REFACTOR | "clean up", "improve", "simplify", "reorganize" |
| CHORE | "update", "upgrade", "maintenance", "dependency" |
| DOCUMENTATION | "docs", "readme", "clarify", "example" |

### 1.4 Assess Severity/Priority, Complexity, and Confidence

Each assessment requires a **one-sentence reasoning** based on concrete findings.

**For BUG issues - Severity:**

| Severity | Criteria |
|----------|----------|
| CRITICAL | System down, data loss, security vulnerability, no workaround |
| HIGH | Major feature broken, significant user impact, difficult workaround |
| MEDIUM | Feature partially broken, moderate impact, workaround exists |
| LOW | Minor issue, cosmetic, edge case, easy workaround |

**For ENHANCEMENT/REFACTOR/CHORE/DOCUMENTATION - Priority:**

| Priority | Criteria |
|----------|----------|
| HIGH | Blocking other work, frequently requested, high user value |
| MEDIUM | Important but not urgent, moderate user value |
| LOW | Nice to have, low urgency, minimal user impact |

**Complexity** (based on codebase findings):

| Complexity | Criteria |
|------------|----------|
| HIGH | 5+ files, multiple integration points, architectural changes |
| MEDIUM | 2-4 files, some integration points, moderate risk |
| LOW | 1-2 files, isolated change, low risk |

**Confidence** (based on evidence quality):

| Confidence | Criteria |
|------------|----------|
| HIGH | Clear root cause, strong evidence, well-understood code path |
| MEDIUM | Likely root cause, some assumptions, partially understood |
| LOW | Uncertain root cause, limited evidence, many unknowns |

---

## Phase 2: EXPLORE - Codebase Intelligence

**CRITICAL: Use the `codebase-explorer` and `codebase-analyst` subagents in parallel.**

### 2.1 Subagent: codebase-explorer

Finds WHERE relevant code lives and extracts patterns to mirror.

```
Find all code relevant to this issue:

ISSUE: {title/description}

LOCATE:
1. Files directly related to this functionality
2. Similar patterns elsewhere to mirror
3. Existing test patterns for this area
4. Error handling patterns used
5. Configuration and type definitions

Categorize findings by purpose (implementation, tests, config, types, docs).
Return ACTUAL code snippets from codebase, not generic examples.
```

### 2.2 Subagent: codebase-analyst

Analyzes HOW the affected code works and traces data flow.

```
Analyze the implementation details related to this issue:

ISSUE: {title/description}

TRACE:
1. How the current implementation works end-to-end
2. Integration points - what calls this, what it calls
3. Data flow through the affected components
4. State changes and side effects
5. Error handling and edge case behavior

Document what exists with precise file:line references. No suggestions.
```

### 2.3 Merge Findings

| Area | File:Lines | Notes |
|------|------------|-------|
| Core logic | `src/x.ts:10-50` | Main function affected |
| Callers | `src/y.ts:20-30` | Uses the core function |
| Types | `src/types/x.ts:5-15` | Relevant interfaces |
| Tests | `src/x.test.ts:1-100` | Existing test patterns |
| Similar | `src/z.ts:40-60` | Pattern to mirror |
| Flow | `src/x.ts:10` -> `y.ts:20` | Data transformation |

---

## Phase 3: ANALYZE - Form Approach

### 3.1 For BUG Issues - Root Cause Analysis

Apply the 5 Whys:

```
WHY 1: Why does [symptom] occur?
-> Because [cause A]
-> Evidence: `file.ts:123` - {code snippet}

WHY 2: Why does [cause A] happen?
-> Because [cause B]
-> Evidence: {proof}

... continue until you reach fixable code ...

ROOT CAUSE: [the specific code/logic to change]
Evidence: `source.ts:456` - {the problematic code}
```

**Check git history:**

```bash
git log --oneline -10 -- {affected-file}
git blame -L {start},{end} {affected-file}
```

### 3.2 For ENHANCEMENT/REFACTOR Issues

**Identify:**

- What needs to be added/changed?
- Where does it integrate?
- What are the scope boundaries?
- What should NOT be changed?

### 3.3 For All Issues

**Determine:**

- Files to CREATE (new files)
- Files to UPDATE (existing files)
- Files to DELETE (if any)
- Dependencies and order of changes
- Edge cases and risks
- Validation strategy

---

## Phase 4: GENERATE - Create Artifact

### 4.1 Artifact Path

```bash
mkdir -p .agents/investigations
```

**Path**: `.agents/investigations/issue-{number}.md`

If free-form (no issue number): `.agents/investigations/{kebab-case-summary}.md`

### 4.2 Artifact Template

Write this structure to the artifact file:

````markdown
# Investigation: {Title}

**Issue**: #{number} ({url})
**Type**: {BUG|ENHANCEMENT|REFACTOR|CHORE|DOCUMENTATION}
**Investigated**: {ISO timestamp}

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | {CRITICAL/HIGH/MEDIUM/LOW} | {why - based on user impact, workarounds, scope} |
| Complexity | {LOW/MEDIUM/HIGH} | {why - based on files affected, integration points, risk} |
| Confidence | {HIGH/MEDIUM/LOW} | {why - based on evidence quality, unknowns, assumptions} |

<!-- For non-BUG types, replace Severity with Priority -->

---

## Problem Statement

{Clear 2-3 sentence description of what's wrong or what's needed}

---

## Analysis

### Root Cause / Change Rationale

{For BUG: The 5 Whys chain with evidence}
{For ENHANCEMENT: Why this change and what it enables}

### Evidence Chain

WHY: {symptom}
-> BECAUSE: {cause 1}
Evidence: `file.ts:123` - `{code snippet}`

-> BECAUSE: {cause 2}
Evidence: `file.ts:456` - `{code snippet}`

-> ROOT CAUSE: {the fixable thing}
Evidence: `file.ts:789` - `{problematic code}`

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/x.ts` | 45-60 | UPDATE | {what changes} |
| `src/x.test.ts` | NEW | CREATE | {test to add} |

### Integration Points

- `src/y.ts:20` calls this function
- `src/z.ts:30` depends on this behavior

### Git History

- **Introduced**: {commit} - {date} - "{message}"
- **Last modified**: {commit} - {date}
- **Implication**: {regression? original bug? long-standing?}

---

## Implementation Plan

### Step 1: {First change description}

**File**: `src/x.ts`
**Lines**: 45-60
**Action**: UPDATE

**Current code:**

```
// Line 45-50
{actual current code}
```

**Required change:**

```
// What it should become
{the fix/change}
```

**Why**: {brief rationale}
**Mirror**: `src/similar.ts:20-30` - follow this pattern

---

### Step 2: {Second change description}

{Same structure...}

---

### Step N: Add/Update Tests

**File**: `src/x.test.ts`
**Action**: {CREATE|UPDATE}

**Test cases:**

```
describe("{feature}", () => {
  it("should {expected behavior}", () => {
    // Test the fix
  });

  it("should handle {edge case}", () => {
    // Test edge case
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```
// SOURCE: src/similar.ts:20-30
// Pattern for {what this demonstrates}
{actual code snippet from codebase}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| {risk 1} | {how to handle} |
| {edge case} | {how to handle} |

---

## Validation

```bash
# Adapt to project's toolchain
pnpm run build    # Type check
pnpm test         # Tests
pnpm run lint     # Lint
```

### Manual Verification

1. {Step to verify the fix/feature works}
2. {Step to verify no regression}

---

## Scope Boundaries

**IN SCOPE:**
- {what we're changing}

**OUT OF SCOPE (do not touch):**
- {what to leave alone}
- {future improvements to defer}
````

---

## Phase 5: POST - GitHub Comment

**Only if input was a GitHub issue (not free-form):**

````bash
gh issue comment {number} --body "$(cat <<'EOF'
## Investigation: {Title}

**Type**: `{TYPE}`

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| {Severity or Priority} | `{VALUE}` | {one-sentence why} |
| Complexity | `{COMPLEXITY}` | {one-sentence why} |
| Confidence | `{CONFIDENCE}` | {one-sentence why} |

---

### Problem Statement

{problem statement from artifact}

---

### Root Cause Analysis

{evidence chain, formatted for GitHub}

---

### Implementation Plan

| Step | File | Change |
|------|------|--------|
| 1 | `src/x.ts:45` | {description} |
| 2 | `src/x.test.ts` | Add test for {case} |

<details>
<summary>Detailed Implementation Steps</summary>

{detailed steps from artifact}

</details>

---

### Validation

```bash
pnpm run build && pnpm test && pnpm run lint
```

---

### Next Step

To implement: `/implement-fix {number}`

---

*Investigation artifact: `.agents/investigations/issue-{number}.md`*
EOF
)"
````

---

## Phase 6: OUTPUT

```markdown
## Investigation Complete

**Issue**: #{number} - {title}
**Type**: {BUG|ENHANCEMENT|REFACTOR|...}

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| {Severity or Priority} | {value} | {why} |
| Complexity | {value} | {why} |
| Confidence | {value} | {why} |

### Key Findings

- **Root Cause**: {one-line summary}
- **Files Affected**: {count} files
- **Estimated Changes**: {brief scope}

### Files to Modify

| File | Action |
|------|--------|
| `src/x.ts` | UPDATE |
| `src/x.test.ts` | CREATE |

### Artifacts

- Investigation: `.agents/investigations/issue-{number}.md`
- GitHub: {Posted to issue | Skipped (free-form input)}

### Next Step

Review the investigation, then: `/implement-fix {number}`
```

---

## Handling Edge Cases

| Scenario | Action |
|----------|--------|
| Issue is already closed | Report it, still create artifact if user wants |
| Issue already has linked PR | Warn user, ask if they want to continue |
| Can't determine root cause | Set confidence to LOW, proceed with best hypothesis |
| Very large scope | Suggest breaking into smaller issues, focus on core problem |
| No GitHub issue (free-form) | Create artifact only, skip GitHub posting |
