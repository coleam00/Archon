---
description: 결과, 미해결 항목, follow-up 제안을 포함한 completion report를 GitHub issue에 게시
argument-hint: (none - reads from workflow artifacts)
---

# Issue 완료 보고서

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## 미션

Compile all workflow artifacts into a final report and post it to the original GitHub issue. Summarize what was done, what wasn't addressed (and why), and suggest follow-up issues if needed.

**GitHub action**: Post completion report as a comment on the original issue
**Output artifact**: `$ARTIFACTS_DIR/completion-report.md`

---

## 1단계: 로드 — 모든 artifact 수집

### 1.1 issue 번호 가져오기

Extract issue number from `$ARGUMENTS`:

```bash
# $ARGUMENTS should be the issue number or URL
echo "$ARGUMENTS"
```

### 1.2 PR 정보 가져오기

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number 2>/dev/null || echo "unknown")
PR_URL=$(cat $ARTIFACTS_DIR/.pr-url 2>/dev/null || echo "unknown")
echo "PR: $PR_NUMBER ($PR_URL)"
```

### 1.3 사용 가능한 모든 artifact 읽기

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

### 1.4 git 정보 가져오기

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

## 2단계: 컴파일 — report 구성

### 2.1 수행 내용 요약

From the artifacts, compile:

- **Classification**: What type of issue (bug/feature/etc)
- **Investigation/Plan**: Key findings and approach
- **Implementation**: What was changed, files modified
- **Validation**: Test results, lint, type-check
- **Review**: What was reviewed, findings count
- **Self-fix**: What review findings were fixed

### 2.2 미해결 항목 식별

From the fix report and consolidated review:

- Findings that were SKIPPED (with reasons)
- Findings that were BLOCKED (with reasons)
- MEDIUM/LOW findings not auto-fixed
- Any validation issues that persisted

### 2.3 follow-up issue 제안

For each unaddressed item, determine if it warrants a follow-up issue:

| Item | Warrants Issue? | Why |
|------|----------------|-----|
| {skipped finding} | YES/NO | {reason} |

**PHASE_2_CHECKPOINT:**

- [ ] Summary compiled
- [ ] Unaddressed items identified
- [ ] Follow-up suggestions prepared

---

## 3단계: 생성 — artifact 작성

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

## 4단계: 게시 — GitHub issue comment

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

## 5단계: 출력 — 최종 요약

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

## 성공 기준

- **ALL_ARTIFACTS_READ**: All workflow artifacts loaded and parsed
- **REPORT_COMPILED**: Comprehensive completion report written
- **GITHUB_POSTED**: Comment posted to original issue
- **UNADDRESSED_DOCUMENTED**: Clear reasons for anything not fixed
- **FOLLOWUPS_SUGGESTED**: Actionable follow-up issues recommended where appropriate
