---
description: Investigate a JIRA bug ticket - analyze codebase, create root cause plan, post summary to JIRA
argument-hint: <JIRA-KEY> (e.g., PROJ-123)
---

# Investigate JIRA Bug

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Investigate the JIRA bug ticket and produce a comprehensive implementation plan that:

1. Can be executed by `archon-fix-issue`
2. Is posted as a JIRA comment so the team can see the findings
3. Captures all context needed for one-pass implementation

**Golden Rule**: The artifact you produce IS the specification. The implementing agent should be able to work from it without asking questions.

---

## Phase 1: LOAD — Read JIRA Ticket

### 1.1 Read JIRA Issue from Artifact

The ticket was already fetched. Read it:

```bash
cat "$ARTIFACTS_DIR/jira-issue.json"
JIRA_KEY=$(cat "$ARTIFACTS_DIR/.jira-key")
JIRA_URL="$JIRA_BASE_URL/browse/$JIRA_KEY"
```

### 1.2 Extract Key Fields

From the JSON, identify:

- **Summary**: `jq -r '.fields.summary'`
- **Description**: `jq -r '.fields.description'` (Atlassian Document Format — parse the text content)
- **Priority**: `jq -r '.fields.priority.name'`
- **Status**: `jq -r '.fields.status.name'`
- **Reporter**: `jq -r '.fields.reporter.displayName'`
- **Assignee**: `jq -r '.fields.assignee.displayName // "Unassigned"'`
- **Labels**: `jq -r '.fields.labels[]'`
- **Components**: `jq -r '.fields.components[].name'`
- **Comments**: `jq -r '.fields.comment.comments[] | "\(.author.displayName): \(.body)"'`
- **Steps to Reproduce** (custom field, if present): look for fields named `customfield_*` with "steps" or "repro" in the key

### 1.3 Assess Severity and Complexity

**Severity** (map from JIRA priority):

| JIRA Priority | Severity |
|---------------|----------|
| Blocker / Critical | CRITICAL |
| Major | HIGH |
| Minor | MEDIUM |
| Trivial | LOW |

**Complexity** (based on codebase findings after Phase 2):

| Complexity | Criteria |
|------------|----------|
| HIGH | 5+ files, multiple integration points, architectural changes, high risk |
| MEDIUM | 2–4 files, some integration points, moderate risk |
| LOW | 1–2 files, isolated change, low risk |

**Confidence** (based on evidence quality after Phase 3):

| Confidence | Criteria |
|------------|----------|
| HIGH | Clear root cause, strong evidence, well-understood code path |
| MEDIUM | Likely root cause, some assumptions, partially understood |
| LOW | Uncertain root cause, limited evidence, many unknowns |

**PHASE_1_CHECKPOINT:**
- [ ] JIRA key and URL captured
- [ ] Summary, description, priority extracted
- [ ] Steps to reproduce identified
- [ ] Comments read for additional context

---

## Phase 2: EXPLORE — Codebase Intelligence

### 2.1 Search for Relevant Code

Use the Task tool with subagent_type="Explore":

```
Explore the codebase to understand the JIRA bug:

ISSUE: {summary from JIRA}
DESCRIPTION: {description text}

DISCOVER:
1. Files directly related to this functionality
2. How the current implementation works
3. Integration points — what calls this, what it calls
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

## Phase 3: ANALYZE — Root Cause

### 3.1 First-Principles Analysis

Before diving in, identify the primitive:

1. **What primitive is involved?** What is the core abstraction this bug touches?
2. **Is the primitive sound?** Does the existing design handle this case?
3. **Root cause vs symptom** — trace the data flow back to the source.
4. **Minimal change?** Smallest edit that fixes the root cause without adding abstractions.

| Primitive | File:Lines | Sound? | Notes |
|-----------|-----------|--------|-------|
| {abstraction} | `src/x.ts:10-30` | Yes/No/Partial | {if incomplete: what's missing} |

### 3.2 Root Cause Analysis (5 Whys)

```
WHY 1: Why does [symptom] occur?
→ Because [cause A]
→ Evidence: `file.ts:123` - {code snippet}

WHY 2: Why does [cause A] happen?
→ Because [cause B]
→ Evidence: {proof}

... continue until fixable root cause ...

ROOT CAUSE: [the specific code/logic to change]
Evidence: `source.ts:456` - {the problematic code}
```

**Check git history:**
```bash
git log --oneline -10 -- {affected-file}
git blame -L {start},{end} {affected-file}
```

### 3.3 Determine Scope

- Files to CREATE (new files)
- Files to UPDATE (existing files)
- Files to DELETE (if any)
- Dependencies and order of changes
- Edge cases and risks
- Validation strategy

**PHASE_3_CHECKPOINT:**
- [ ] Root cause identified with evidence chain
- [ ] All affected files listed with specific changes
- [ ] Scope boundaries defined (what NOT to change)
- [ ] Risks and edge cases identified
- [ ] Validation approach defined

---

## Phase 4: GENERATE — Write Artifact

**Path:** `$ARTIFACTS_DIR/investigation.md`

```markdown
# Investigation: {Summary}

**JIRA**: [{JIRA_KEY}]({JIRA_URL})
**Priority**: {JIRA priority}
**Investigated**: {ISO timestamp}

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | {CRITICAL\|HIGH\|MEDIUM\|LOW} | {Why this severity?} |
| Complexity | {LOW\|MEDIUM\|HIGH} | {Why this complexity?} |
| Confidence | {HIGH\|MEDIUM\|LOW} | {Why this confidence?} |

---

## Problem Statement

{Clear 2–3 sentence description of what's wrong}

---

## Analysis

### Root Cause

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

### Git History

- **Introduced**: {commit} — {date} — "{message}"
- **Last modified**: {commit} — {date}

---

## Implementation Plan

### Step 1: {First change}

**File**: `src/x.ts`
**Lines**: 45-60
**Action**: UPDATE

**Current code:**
```typescript
{actual current code}
```

**Required change:**
```typescript
{the fix}
```

**Why**: {brief rationale}

---

### Step N: Add/Update Tests

**File**: `src/x.test.ts`
**Action**: {CREATE|UPDATE}

**Test cases to add:**
```typescript
describe('{feature}', () => {
  it('should {expected behavior}', () => {});
  it('should handle {edge case}', () => {});
});
```

---

## Patterns to Follow

```typescript
// SOURCE: src/similar.ts:20-30
{actual code snippet from codebase}
```

---

## Edge Cases & Risks

| Risk/Edge Case | Mitigation |
|----------------|------------|
| {risk 1} | {how to handle} |

---

## Validation

```bash
bun run type-check
bun test {relevant-pattern}
bun run lint
```

---

## Scope Boundaries

**IN SCOPE:**
- {what we're changing}

**OUT OF SCOPE (do not touch):**
- {what to leave alone}
```

**PHASE_4_CHECKPOINT:**
- [ ] Artifact file created at `$ARTIFACTS_DIR/investigation.md`
- [ ] All sections filled with specific content
- [ ] Code snippets are actual (not invented)
- [ ] Steps are actionable without clarification

---

## Phase 5: POST — JIRA Comment

Post the investigation summary to the JIRA ticket so the team can review the findings:

```bash
JIRA_KEY=$(cat "$ARTIFACTS_DIR/.jira-key")

# Build ADF comment JSON
SUMMARY_TEXT="Investigation complete for $JIRA_KEY.

Root Cause: {one-line root cause summary}

Affected Files: {comma-separated list}

Severity: {value} | Complexity: {value} | Confidence: {value}

Implementation plan saved. Fix in progress via Archon workflow $WORKFLOW_ID."

ADF_BODY=$(jq -n --arg text "$SUMMARY_TEXT" '{
  body: {
    version: 1,
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: {level: 2},
        content: [{type: "text", text: "🔍 Investigation Complete"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $text}]
      }
    ]
  }
}')

curl -s -X POST \
  -u "$JIRA_USER:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$JIRA_KEY/comment" \
  -H "Content-Type: application/json" \
  -d "$ADF_BODY" > /dev/null

echo "Posted investigation summary to $JIRA_KEY"
```

**PHASE_5_CHECKPOINT:**
- [ ] ADF comment posted to JIRA ticket

---

## Phase 6: REPORT — Output to User

```markdown
## Investigation Complete

**Ticket**: {JIRA_KEY} — {summary}
**JIRA URL**: {JIRA_URL}

### Assessment

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Severity | {value} | {why} |
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

### Artifact

📄 `$ARTIFACTS_DIR/investigation.md`

### JIRA

✅ Investigation summary posted to {JIRA_KEY}
```

---

## Handling Edge Cases

### Cannot determine root cause
- Document what was found
- Set confidence to LOW
- Note uncertainty in artifact
- Proceed with best hypothesis

### Very large scope
- Suggest breaking into smaller tickets
- Focus on core problem first
- Note deferred items in "Out of Scope"

### JIRA description is in ADF format
- Extract text content from ADF nodes recursively using jq
- Focus on `text` type leaf nodes within the `content` arrays

---

## Success Criteria

- **ARTIFACT_COMPLETE**: All sections filled with specific, actionable content
- **EVIDENCE_BASED**: Every claim has file:line reference or proof
- **IMPLEMENTABLE**: Another agent can execute without questions
- **JIRA_POSTED**: Investigation summary comment visible on ticket
