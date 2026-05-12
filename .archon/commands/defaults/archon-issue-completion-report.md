---
description: Post completion report to GitHub issue with results, unaddressed items, and follow-up suggestions
argument-hint: (none - reads from workflow artifacts)
---

# Issue Completion Report

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Compile all workflow artifacts into a final report and post it to the original GitHub issue. Summarize what was done, what wasn't addressed (and why), and suggest follow-up issues if needed.

**GitHub action**: Post completion report as a comment on the original issue
**Output artifact**: `$ARTIFACTS_DIR/completion-report.md`

---

## Phase 1: LOAD — Gather All Artifacts

### 1.1 Get Issue Number

Extract issue number from `$ARGUMENTS`:

```bash
# $ARGUMENTS should be the issue number or URL
echo "$ARGUMENTS"
```

### 1.2 Get PR Info

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number 2>/dev/null || echo "unknown")
PR_URL=$(cat $ARTIFACTS_DIR/.pr-url 2>/dev/null || echo "unknown")
echo "PR: $PR_NUMBER ($PR_URL)"
```

### 1.3 Read All Available Artifacts

Check for and read each artifact that may exist:

```bash
# Investigation/Plan
cat $ARTIFACTS_DIR/investigation.md 2>/dev/null
cat $ARTIFACTS_DIR/plan.md 2>/dev/null

# Implementation
cat $ARTIFACTS_DIR/implementation.md 2>/dev/null

# Web research
cat $ARTIFACTS_DIR/web-research.md 2>/dev/null

# Validation
cat $ARTIFACTS_DIR/validation.md 2>/dev/null

# Review artifacts
ls $ARTIFACTS_DIR/review/ 2>/dev/null
cat $ARTIFACTS_DIR/review/consolidated-review.md 2>/dev/null
cat $ARTIFACTS_DIR/review/fix-report.md 2>/dev/null
```

### 1.4 Get Git Info

```bash
git branch --show-current
git log --oneline -5
```

**PHASE_1_CHECKPOINT:**

- [ ] Issue number identified
- [ ] PR info loaded
- [ ] All available artifacts read
- [ ] Git state captured

---

## Phase 2: COMPILE — Build Report

### 2.1 Summarize What Was Done

From the artifacts, compile:

- **Classification**: What type of issue (bug/feature/etc)
- **Investigation/Plan**: Key findings and approach
- **Implementation**: What was changed, files modified
- **Validation**: Test results, lint, type-check
- **Review**: What was reviewed, findings count
- **Self-fix**: What review findings were fixed

### 2.2 Identify Unaddressed Items

From the fix report and consolidated review:

- Findings that were SKIPPED (with reasons)
- Findings that were BLOCKED (with reasons)
- MEDIUM/LOW findings not auto-fixed
- Any validation issues that persisted

### 2.3 Suggest Follow-up Issues

For each unaddressed item, determine if it warrants a follow-up issue:

| Item | Warrants Issue? | Why |
|------|----------------|-----|
| {skipped finding} | YES/NO | {reason} |

**PHASE_2_CHECKPOINT:**

- [ ] Summary compiled
- [ ] Unaddressed items identified
- [ ] Follow-up suggestions prepared

---

## Phase 3: GENERATE — Write Artifact

Write to `$ARTIFACTS_DIR/completion-report.md`:

```markdown
# Completion Report: Issue $ARGUMENTS

**Date**: {ISO timestamp}
**Workflow ID**: $WORKFLOW_ID
**PR**: #{pr-number} ({pr-url})

---

## Summary

{3-5 sentence overview of the entire workflow execution}

---

## Classification

| Field | Value |
|-------|-------|
| Type | {bug/feature/enhancement/...} |
| Complexity | {LOW/MEDIUM/HIGH} |
| Confidence | {HIGH/MEDIUM/LOW} |

---

## What Was Done

### Investigation/Planning

{Brief summary of root cause or plan}

### Implementation

| File | Action | Description |
|------|--------|-------------|
| `{file}` | {CREATE/UPDATE} | {what changed} |

### Validation

| Check | Result |
|-------|--------|
| Type check | ✅ / ❌ |
| Lint | ✅ / ❌ |
| Tests | ✅ ({n} passed) / ❌ |

### Review & Self-Fix

- **Findings**: {n} total from review agents
- **Fixed**: {n} (including tests, docs, simplification)
- **Skipped**: {n}
- **Blocked**: {n}

---

## Unaddressed Items

{If none: "All findings were addressed."}

### Skipped

| Finding | Severity | Reason |
|---------|----------|--------|
| {title} | {sev} | {reason} |

### Blocked

| Finding | Severity | Reason |
|---------|----------|--------|
| {title} | {sev} | {reason} |

---

## Suggested Follow-up Issues

| Title | Priority | Description |
|-------|----------|-------------|
| "{title}" | {P1/P2/P3} | {brief description} |

*(none)* if everything was addressed

---

## Artifacts

| Artifact | Path |
|----------|------|
| Investigation/Plan | `$ARTIFACTS_DIR/{investigation or plan}.md` |
| Web Research | `$ARTIFACTS_DIR/web-research.md` |
| Implementation | `$ARTIFACTS_DIR/implementation.md` |
| Consolidated Review | `$ARTIFACTS_DIR/review/consolidated-review.md` |
| Fix Report | `$ARTIFACTS_DIR/review/fix-report.md` |
```

**PHASE_3_CHECKPOINT:**

- [ ] Completion report written

---

## Phase 4: POST — GitHub Issue Comment

Post to the original GitHub issue:

```bash
ISSUE_NUMBER=$(echo "$ARGUMENTS" | grep -oE '[0-9]+')

gh issue comment $ISSUE_NUMBER --body "$(cat <<'EOF'
## ✅ Issue Resolution Report

**PR**: #{pr-number} ({pr-url})
**Status**: COMPLETE

---

### Summary

{Brief overview of what was done to resolve this issue}

---

### Changes Made

| File | Change |
|------|--------|
| `{file}` | {description} |

---

### Validation

✅ Type check | ✅ Lint | ✅ Tests ({n} passed)

---

### Review & Self-Fix

- **{n}** review findings addressed
- **{n}** tests added
- **{n}** docs updated
- **{n}** code simplifications applied

---

### Unaddressed Items

{If none: "All review findings were addressed in the PR."}

{If any:}

| Finding | Severity | Reason |
|---------|----------|--------|
| {title} | {sev} | {why not addressed} |

---

### Suggested Follow-up Issues

{If any:}

1. **{Issue Title}** ({priority}) — {brief description}

{If none: "No follow-up issues needed."}

---

*Resolved by Archon workflow `$WORKFLOW_ID`*
EOF
)"
```

**PHASE_4_CHECKPOINT:**

- [ ] GitHub comment posted to issue

---

## Phase 5: OUTPUT — Final Summary

```markdown
## Issue Resolution Complete

**Issue**: $ARGUMENTS
**PR**: #{pr-number}
**Workflow**: $WORKFLOW_ID

### Results

- Implementation: ✅
- Validation: ✅
- Review: ✅
- Self-fix: ✅

### Unaddressed: {n} items
### Follow-up issues suggested: {n}

### Artifacts

- Completion report: `$ARTIFACTS_DIR/completion-report.md`
- GitHub comment: Posted to issue

### Next Steps

1. Review the PR: #{pr-number}
2. Create suggested follow-up issues if agreed
3. Merge when ready
```

---

## Success Criteria

- **ALL_ARTIFACTS_READ**: All workflow artifacts loaded and parsed
- **REPORT_COMPILED**: Comprehensive completion report written
- **GITHUB_POSTED**: Comment posted to original issue
- **UNADDRESSED_DOCUMENTED**: Clear reasons for anything not fixed
- **FOLLOWUPS_SUGGESTED**: Actionable follow-up issues recommended where appropriate
