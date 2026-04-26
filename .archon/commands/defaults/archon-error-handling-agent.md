---
description: silent failure, 부실한 catch block, 취약한 fallback을 중심으로 error handling 검토
argument-hint: (none - reads from scope artifact)
---

# 오류 처리 Agent

---

## 미션

Hunt for silent failures, inadequate error handling, broad catch blocks, and inappropriate fallback behavior. Produce a structured artifact with findings, fix suggestions with options, and reasoning.

**Output artifact**: `$ARTIFACTS_DIR/review/error-handling-findings.md`

---

## 1단계: 로드 — 컨텍스트 수집

### 1.1 registry에서 PR 번호 가져오기

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### 1.2 scope 읽기

```bash
cat $ARTIFACTS_DIR/review/scope.md
```

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as bugs or missing features!

### 1.3 PR diff 가져오기

```bash
gh pr diff {number}
```

### 1.4 읽기 CLAUDE.md 오류 Handling 규칙

```bash
cat CLAUDE.md | grep -A 20 -i "error"
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Scope loaded
- [ ] Diff available

---

## 2단계: 분석 — issue 탐색

### 2.1 모든 error handling 코드 찾기

Search for:
- `try { ... } catch` blocks
- `.catch(` handlers
- `|| fallback` patterns
- `?? defaultValue` patterns
- `?.` optional chaining that might hide errors
- Error event handlers
- Conditional error state handling

### 2.2 각 handler 세밀 검토

For every error handling location, evaluate:

**Logging Quality:**
- Is error logged with appropriate severity?
- Does log include sufficient context?
- Would this help debugging in 6 months?

**User Feedback:**
- Does user receive actionable feedback?
- Is the error message specific and helpful?
- Are technical details appropriately hidden/shown?

**Catch Block Specificity:**
- Does it catch only expected error types?
- Could it accidentally suppress unrelated errors?
- Should it be multiple catch blocks?

**Fallback Behavior:**
- Is fallback explicitly documented/intended?
- Does fallback mask the underlying problem?
- Is user aware they're seeing fallback behavior?

### 2.3 codebase error pattern 찾기

```bash
# Find error handling patterns in codebase
grep -r "catch" src/ --include="*.ts" -A 3 | head -30
grep -r "console.error" src/ --include="*.ts" -B 2 -A 2 | head -30
```

**PHASE_2_CHECKPOINT:**
- [ ] All error handlers identified
- [ ] Each handler evaluated
- [ ] Codebase patterns found

---

## 3단계: 생성 — artifact 생성

Write to `$ARTIFACTS_DIR/review/error-handling-findings.md`:

```markdown
# Error Handling Findings: PR #{number}

**Reviewer**: error-handling-agent
**Date**: {ISO timestamp}
**Error Handlers Reviewed**: {count}

---

## Summary

{2-3 sentence overview of error handling quality}

**Verdict**: {APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION}

---

## Findings

### Finding 1: {Descriptive Title}

**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: silent-failure | broad-catch | missing-logging | poor-user-feedback | unsafe-fallback
**Location**: `{file}:{line}`

**Issue**:
{Clear description of the error handling problem}

**Evidence**:
```typescript
// Current error handling at {file}:{line}
{problematic code}
```

**Hidden Errors**:
This catch block could silently hide:
- {Error type 1}: {scenario when it occurs}
- {Error type 2}: {scenario when it occurs}
- {Error type 3}: {scenario when it occurs}

**User Impact**:
{What happens to the user when this error occurs? Why is it bad?}

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | {e.g., Add specific error types} | {benefits} | {drawbacks} |
| B | {e.g., Add logging + user message} | {benefits} | {drawbacks} |
| C | {e.g., Propagate error instead} | {benefits} | {drawbacks} |

**권장**: Option {X}

**Reasoning**:
{Explain why this option is preferred:
- Aligns with project error handling patterns
- Provides better debugging experience
- Gives users actionable feedback
- Follows CLAUDE.md rules}

**권장 수정**:
```typescript
// 개선된 error handling
{corrected code with proper logging, specific catches, user feedback}
```

**Codebase Pattern Reference**:
```typescript
// SOURCE: {file}:{lines}
// This is how similar errors are handled elsewhere
{existing error handling pattern from codebase}
```

---

### Finding 2: {Title}

{Same structure...}

---

## Error Handler Audit

| Location | Type | Logging | User Feedback | Specificity | Verdict |
|----------|------|---------|---------------|-------------|---------|
| `file:line` | try-catch | GOOD/BAD | GOOD/BAD | GOOD/BAD | PASS/FAIL |
| ... | ... | ... | ... | ... | ... |

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | {n} | {n} |
| HIGH | {n} | {n} |
| MEDIUM | {n} | {n} |
| LOW | {n} | {n} |

---

## Silent Failure Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {potential silent failure} | HIGH/MED/LOW | {user impact} | {fix needed} |
| ... | ... | ... | ... |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `src/example.ts` | 42-50 | {error handling pattern} |
| ... | ... | ... |

---

## Positive Observations

{Error handling done well, good patterns, proper logging}

---

## Metadata

- **Agent**: error-handling-agent
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/error-handling-findings.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All error handlers audited
- [ ] Hidden errors listed for each finding
- [ ] Fix options with reasoning provided

---

## 성공 기준

- **ERROR_HANDLERS_FOUND**: All try/catch, .catch, fallbacks identified
- **EACH_HANDLER_AUDITED**: Logging, feedback, specificity evaluated
- **HIDDEN_ERRORS_LISTED**: Each finding lists what could be hidden
- **ARTIFACT_CREATED**: Findings file written with complete structure
