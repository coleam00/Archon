---
description: Investigate a GitHub issue or problem - analyze codebase, create plan, post to GitHub
argument-hint: <issue-number|url|"description">
---

# Investigate Issue

**Input**: $ARGUMENTS

---

## Your Mission

Investigate the issue/problem and produce a comprehensive implementation plan that:

1. Can be executed by `/implement-issue`
2. Is posted as a GitHub comment (if GH issue provided)
3. Captures all context needed for one-pass implementation

**Golden Rule**: The artifact you produce IS the specification. The implementing agent should be able to work from it without asking questions.

---

## Phase 1: PARSE - Understand Input

### 1.1 Determine Input Type

**Check the input format:**

- Looks like a number (`123`, `#123`) → GitHub issue number
- Starts with `http` → GitHub URL (extract issue number)
- Anything else → Free-form description

```bash
# If GitHub issue, fetch it:
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

Each assessment requires a **one-sentence reasoning** explaining WHY you chose that value. This reasoning must be based on concrete findings from your investigation (codebase exploration, git history, integration analysis).

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
| HIGH | 5+ files, multiple integration points, architectural changes, high risk |
| MEDIUM | 2-4 files, some integration points, moderate risk |
| LOW | 1-2 files, isolated change, low risk |

**Confidence** (based on evidence quality):

| Confidence | Criteria |
|------------|----------|
| HIGH | Clear root cause, strong evidence, well-understood code path |
| MEDIUM | Likely root cause, some assumptions, partially understood |
| LOW | Uncertain root cause, limited evidence, many unknowns |

**PHASE_1_CHECKPOINT:**
- [ ] Input type identified (GH issue or free-form)
- [ ] Issue content extracted
- [ ] Type classified
- [ ] Severity (bug) or Priority (other) assessed with reasoning
- [ ] Complexity assessed with reasoning (after Phase 2)
- [ ] Confidence assessed with reasoning (after Phase 3)
- [ ] If GH issue: confirmed it's open and not already has PR

---

## Phase 2: EXPLORE - Codebase Intelligence

### 2.1 Search for Relevant Code

Use Task tool with subagent_type="Explore":

```
Explore the codebase to understand the issue:

ISSUE: {title/description}

DISCOVER:
1. Files directly related to this functionality
2. How the current implementation works
3. Integration points - what calls this, what it calls
4. Similar patterns elsewhere to mirror
5. Existing test patterns for this area
6. Error handling patterns used

Return:
- File paths with specific line numbers
- Actual code snippets (not summaries)
- Dependencies and data flow
```

### 2.2 Document Findings

| Area | File:Lines | Notes |
|------|-----------|-------|
| Core logic | `src/x.ts:10-50` | Main function affected |
| Callers | `src/y.ts:20-30` | Uses the core function |
| Types | `src/types/x.ts:5-15` | Relevant interfaces |
| Tests | `src/x.test.ts:1-100` | Existing test patterns |
| Similar | `src/z.ts:40-60` | Pattern to mirror |

**PHASE_2_CHECKPOINT:**
- [ ] Explore agent completed successfully
- [ ] Core files identified with line numbers
- [ ] Integration points mapped
- [ ] Similar patterns found to mirror
- [ ] Test patterns documented

---

## Phase 3: ANALYZE - Form Approach

### 3.0 First-Principles Analysis

Before diving into bug analysis or enhancement scoping, identify the primitive:

1. **What primitive is involved?** What is the core abstraction this bug/feature touches?
   (e.g., the condition evaluator, the approval system, the isolation provider)
2. **Is the primitive sound?** Does the existing design handle this case, or is the
   primitive itself incomplete or missing a case?
3. **Root cause vs symptom** — are we fixing where the error manifests, or where it
   originates? Trace the data flow back to the source.
4. **What's the minimal change?** What is the smallest edit that fixes the root cause?
   Avoid adding new abstractions when extending existing ones works.
5. **What does this unlock?** If we add/change a primitive, what other improvements
   become possible?

| Primitive | File:Lines | Sound? | Notes |
|-----------|-----------|--------|-------|
| {abstraction name} | `src/x.ts:10-30` | Yes/No/Partial | {if incomplete: what's missing} |

### 3.1 For BUG Issues - Root Cause Analysis

Apply the 5 Whys:

```
WHY 1: Why does [symptom] occur?
→ Because [cause A]
→ Evidence: `file.ts:123` - {code snippet}

WHY 2: Why does [cause A] happen?
→ Because [cause B]
→ Evidence: {proof}

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

**PHASE_3_CHECKPOINT:**
- [ ] Root cause identified (for bugs) OR change rationale clear (for enhancements)
- [ ] All affected files listed with specific changes
- [ ] Scope boundaries defined (what NOT to change)
- [ ] Risks and edge cases identified
- [ ] Validation approach defined

---

## Phase 4: GENERATE - Create Artifact

### 4.1 Artifact Path

```bash
```

**Path:** `$ARTIFACTS_DIR/investigation.md`

This unified path allows review agents to find the artifact regardless of workflow type.

### 4.2 Artifact Template

Write this structure to the artifact file.

**Note on Severity vs Priority:**
- Use **Severity** for BUG type (CRITICAL, HIGH, MEDIUM, LOW)
- Use **Priority** for all other types (HIGH, MEDIUM, LOW)

**Important:** Each assessment must include a one-sentence reasoning based on your investigation findings.

```markdown
# Investigation: {Title}

**Issue**: #{number} ({url})
**Type**: {BUG|ENHANCEMENT|REFACTOR|CHORE|DOCUMENTATION}
**Investigated**: {ISO timestamp}

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | {CRITICAL\|HIGH\|MEDIUM\|LOW} | {Why this severity? Based on user impact, workarounds, scope of failure} |
| Complexity | {LOW\|MEDIUM\|HIGH} | {Why this complexity? Based on files affected, integration points, risk} |
| Confidence | {HIGH\|MEDIUM\|LOW} | {Why this confidence? Based on evidence quality, unknowns, assumptions} |

<!-- For non-BUG types, replace Severity row with Priority:
| Priority | {HIGH\|MEDIUM\|LOW} | {Why this priority? Based on user value, blocking status, frequency} |
-->

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
↓ BECAUSE: {cause 1}
  Evidence: `file.ts:123` - `{code snippet}`

↓ BECAUSE: {cause 2}
  Evidence: `file.ts:456` - `{code snippet}`

↓ ROOT CAUSE: {the fixable thing}
  Evidence: `file.ts:789` - `{problematic code}`

### Affected Files

| File | Lines | Action | Description |
|------|-------|--------|-------------|
| `src/x.ts` | 45-60 | UPDATE | {what changes} |
| `src/x.test.ts` | NEW | CREATE | {test to add} |

### Integration Points

- `src/y.ts:20` calls this function
- `src/z.ts:30` depends on this behavior
- {other dependencies}

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
```typescript
// Line 45-50
{actual current code}
```

**Required change:**
```typescript
// What it should become
{the fix/change}
```

**Why**: {brief rationale}

---

### Step 2: {Second change description}

{Same structure...}

---

### Step N: Add/Update Tests

**File**: `src/x.test.ts`
**Action**: {CREATE|UPDATE}

**Test cases to add:**
```typescript
describe('{feature}', () => {
  it('should {expected behavior}', () => {
    // Test the fix
  });

  it('should handle {edge case}', () => {
    // Test edge case
  });
});
```

---

## Patterns to Follow

**From codebase - mirror these exactly:**

```typescript
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

### Automated Checks

```bash
bun run type-check
bun test {relevant-pattern}
bun run lint
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

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/investigation.md`
```

**PHASE_4_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All sections filled with specific content
- [ ] Code snippets are actual (not invented)
- [ ] Steps are actionable without clarification

---

## Phase 5: POST - GitHub Comment

**Only if input was a GitHub issue (not free-form):**

Format the artifact for GitHub and post:

```bash
gh issue comment {number} --body "$(cat <<'EOF'
## 🔍 Investigation: {Title}

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
<summary>📋 Detailed Implementation Steps</summary>

{detailed steps from artifact}

</details>

---

### Validation

```bash
bun run type-check && bun test {pattern} && bun run lint
```

---

### Next Step

To implement: `/implement-issue {number}`

---
*Investigated by Claude • {timestamp}*
EOF
)"
```

**PHASE_5_CHECKPOINT:**
- [ ] Comment posted to GitHub (if GH issue)
- [ ] Formatting renders correctly

---

## Phase 6: REPORT - Output to User

```markdown
## Investigation Complete

**Issue**: #{number} - {title}
**Type**: {BUG|ENHANCEMENT|REFACTOR|...}

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| {Severity or Priority} | {value} | {why - based on investigation} |
| Complexity | {LOW\|MEDIUM\|HIGH} | {why - based on files/integration/risk} |
| Confidence | {HIGH\|MEDIUM\|LOW} | {why - based on evidence/unknowns} |

### Key Findings

- **Root Cause**: {one-line summary}
- **Files Affected**: {count} files
- **Estimated Changes**: {brief scope}

### Files to Modify

| File | Action |
|------|--------|
| `src/x.ts` | UPDATE |
| `src/x.test.ts` | CREATE |

### Artifact

📄 `$ARTIFACTS_DIR/investigation.md`

### GitHub

{✅ Posted to issue | ⏭️ Skipped (free-form input)}

### Next Step

Run `/implement-issue {number}` to execute the plan.
```

---

## Handling Edge Cases

### Issue is already closed
- Report: "Issue #{number} is already closed"
- Still create artifact if user wants analysis

### Issue already has linked PR
- Warn: "PR #{pr} already addresses this issue"
- Ask if user wants to continue anyway

### Can't determine root cause
- Document what you found
- Set confidence to LOW
- Note uncertainty in artifact
- Proceed with best hypothesis

### Very large scope
- Suggest breaking into smaller issues
- Focus on core problem first
- Note deferred items in "Out of Scope"

---

## Success Criteria

- **ARTIFACT_COMPLETE**: All sections filled with specific, actionable content
- **EVIDENCE_BASED**: Every claim has file:line reference or proof
- **IMPLEMENTABLE**: Another agent can execute without questions
- **GITHUB_POSTED**: Comment visible on issue (if GH issue)
- **COMMITTED**: Artifact saved in git
