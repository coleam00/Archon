---
description: Review code comments for accuracy, completeness, and maintainability
argument-hint: (none - reads from scope artifact)
---

# Comment Quality Agent

---

## Your Mission

Analyze code comments for accuracy against actual code, identify comment rot, check documentation completeness, and ensure comments aid long-term maintainability. Produce a structured artifact with findings and recommendations.

**Output artifact**: `$ARTIFACTS_DIR/review/comment-quality-findings.md`

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

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as missing documentation or comment issues!

### 1.3 Get PR Diff

```bash
gh pr diff {number}
```

Focus on:
- New comments added
- Comments near modified code
- JSDoc/docstrings added or changed

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Changed files with comments identified
- [ ] Diff available

---

## Phase 2: ANALYZE - Review Comments

### 2.1 Check Comment Accuracy

For each comment in changed code:
- Does the comment accurately describe what the code does?
- Is the comment up-to-date with the implementation?
- Are parameter descriptions correct?
- Are return value descriptions accurate?
- Are edge cases documented correctly?

### 2.2 Identify Comment Rot

Look for:
- Comments that describe old behavior
- TODO/FIXME that should have been addressed
- Outdated references (old file names, removed functions)
- Comments that contradict the code

### 2.3 Check Documentation Completeness

Evaluate:
- Are complex functions properly documented?
- Are public APIs documented?
- Are non-obvious algorithms explained?
- Are magic numbers/constants explained?
- Are important decisions documented?

### 2.4 Assess Maintainability

Consider:
- Will future developers understand the "why"?
- Are there redundant comments (just restating code)?
- Is the signal-to-noise ratio good?
- Are comments in the right places?

**PHASE_2_CHECKPOINT:**
- [ ] Comment accuracy verified
- [ ] Comment rot identified
- [ ] Completeness gaps found
- [ ] Maintainability assessed

---

## Phase 3: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/review/comment-quality-findings.md`:

```markdown
# Comment Quality Findings: PR #{number}

**Reviewer**: comment-quality-agent
**Date**: {ISO timestamp}
**Comments Reviewed**: {count}

---

## Summary

{2-3 sentence overview of comment quality}

**Verdict**: {APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION}

---

## Findings

### Finding 1: {Descriptive Title}

**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: inaccurate | outdated | missing | redundant | misleading
**Location**: `{file}:{line}`

**Issue**:
{Clear description of the comment problem}

**Current Comment**:
```typescript
// {the problematic comment}
{code the comment describes}
```

**Actual Code Behavior**:
{What the code actually does vs what comment says}

**Impact**:
{How this could mislead future developers}

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | {update comment} | {benefits} | {drawbacks} |
| B | {remove comment} | {benefits} | {drawbacks} |
| C | {expand comment} | {benefits} | {drawbacks} |

**Recommended**: Option {X}

**Reasoning**:
{Why this option:
- Matches documentation standards
- Provides value without being redundant
- Will remain accurate over time}

**Recommended Fix**:
```typescript
/**
 * {corrected/improved comment}
 *
 * @param {type} param - {accurate description}
 * @returns {type} - {accurate description}
 */
{code}
```

**Good Comment Pattern**:
```typescript
// SOURCE: {file}:{lines}
// Example of good documentation in this codebase
{existing well-documented code}
```

---

### Finding 2: {Title}

{Same structure...}

---

## Comment Audit

| Location | Type | Accurate | Up-to-date | Useful | Verdict |
|----------|------|----------|------------|--------|---------|
| `file:line` | JSDoc | YES/NO | YES/NO | YES/NO | GOOD/UPDATE/REMOVE |
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

## Documentation Gaps

| Code Area | What's Missing | Priority |
|-----------|----------------|----------|
| `function xyz()` | Parameter docs, return type | HIGH |
| `class Abc` | Class purpose, usage example | MEDIUM |
| ... | ... | ... |

---

## Comment Rot Found

| Location | Comment Says | Code Does | Age |
|----------|--------------|-----------|-----|
| `file:line` | "{old description}" | {actual behavior} | {when introduced} |
| ... | ... | ... | ... |

---

## Positive Observations

{Well-documented code, helpful comments, good explanations}

---

## Metadata

- **Agent**: comment-quality-agent
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/comment-quality-findings.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] Comment accuracy verified
- [ ] Comment rot documented
- [ ] Documentation gaps listed

---

## Success Criteria

- **COMMENTS_AUDITED**: All comments in changed code reviewed
- **ACCURACY_CHECKED**: Comments verified against actual code
- **ROT_IDENTIFIED**: Outdated comments found
- **GAPS_DOCUMENTED**: Missing documentation noted
