---
description: Review error handling for silent failures, inadequate catch blocks, and poor fallbacks
argument-hint: (none - reads from scope artifact)
---

# Error Handling Agent

---

## Your Mission

Hunt for silent failures, inadequate error handling, broad catch blocks, and inappropriate fallback behavior. Produce a structured artifact with findings, fix suggestions with options, and reasoning.

**Output artifact**: `$ARTIFACTS_DIR/review/error-handling-findings.md`

---

## Phase 1: LOAD - Get Context

### 1.1 Get PR Number from Registry

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### 1.2 Read Scope

```bash
cat $ARTIFACTS_DIR/review/scope.md
```

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as bugs or missing features!

### 1.3 Get PR Diff

```bash
gh pr diff {number}
```

### 1.4 Read CLAUDE.md Error Handling Rules

```bash
cat CLAUDE.md | grep -A 20 -i "error"
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Scope loaded
- [ ] Diff available

---

## Phase 2: ANALYZE - Hunt for Issues

### 2.1 Find All Error Handling Code

Search for:
- `try { ... } catch` blocks
- `.catch(` handlers
- `|| fallback` patterns
- `?? defaultValue` patterns
- `?.` optional chaining that might hide errors
- Error event handlers
- Conditional error state handling

### 2.2 Scrutinize Each Handler

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

### 2.3 Find Codebase Error Patterns

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

## Phase 3: GENERATE - Create Artifact

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

**Recommended**: Option {X}

**Reasoning**:
{Explain why this option is preferred:
- Aligns with project error handling patterns
- Provides better debugging experience
- Gives users actionable feedback
- Follows CLAUDE.md rules}

**Recommended Fix**:
```typescript
// Improved error handling
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

## Success Criteria

- **ERROR_HANDLERS_FOUND**: All try/catch, .catch, fallbacks identified
- **EACH_HANDLER_AUDITED**: Logging, feedback, specificity evaluated
- **HIDDEN_ERRORS_LISTED**: Each finding lists what could be hidden
- **ARTIFACT_CREATED**: Findings file written with complete structure
