---
description: Review test coverage quality, identify gaps, and evaluate test effectiveness
argument-hint: (none - reads from scope artifact)
---

# Test Coverage Agent

---

## Your Mission

Analyze test coverage for the PR changes. Identify critical gaps, evaluate test quality, and ensure tests verify behavior (not implementation). Produce a structured artifact with findings and recommendations.

**Output artifact**: `$ARTIFACTS_DIR/review/test-coverage-findings.md`

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

Note which files are source vs test files.

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as bugs or missing test coverage!

### 1.3 Get PR Diff

```bash
gh pr diff {number}
```

### 1.4 Read Existing Tests

For each new/modified source file, find corresponding test file:

```bash
# Find test files
find src -name "*.test.ts" -o -name "*.spec.ts" | head -20
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Source and test files identified
- [ ] Existing test patterns noted

---

## Phase 2: ANALYZE - Evaluate Coverage

### 2.1 Map Source to Tests

For each changed source file:
- Does a corresponding test file exist?
- Are new functions/features tested?
- Are modified functions' tests updated?

### 2.2 Identify Critical Gaps

Look for untested:
- Error handling paths
- Edge cases (null, empty, boundary values)
- Critical business logic
- Security-sensitive code
- Async/concurrent behavior
- Integration points

### 2.3 Evaluate Test Quality

For existing tests, check:
- Do they test behavior or implementation?
- Would they catch meaningful regressions?
- Are they resilient to refactoring?
- Do they follow DAMP principles?
- Are assertions meaningful?

### 2.4 Find Test Patterns

```bash
# Find test patterns in codebase
grep -r "describe\|it\|test\(" src/ --include="*.test.ts" | head -20
```

**PHASE_2_CHECKPOINT:**
- [ ] Source-to-test mapping complete
- [ ] Critical gaps identified
- [ ] Test quality evaluated
- [ ] Codebase test patterns found

---

## Phase 3: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/review/test-coverage-findings.md`:

```markdown
# Test Coverage Findings: PR #{number}

**Reviewer**: test-coverage-agent
**Date**: {ISO timestamp}
**Source Files**: {count}
**Test Files**: {count}

---

## Summary

{2-3 sentence overview of test coverage quality}

**Verdict**: {APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION}

---

## Coverage Map

| Source File | Test File | New Code Tested | Modified Code Tested |
|-------------|-----------|-----------------|---------------------|
| `src/x.ts` | `src/x.test.ts` | FULL/PARTIAL/NONE | FULL/PARTIAL/NONE |
| `src/y.ts` | (missing) | N/A | N/A |
| ... | ... | ... | ... |

---

## Findings

### Finding 1: {Descriptive Title}

**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: missing-test | weak-test | implementation-coupled | missing-edge-case
**Location**: `{file}:{line}` (source) / `{test-file}` (test)
**Criticality Score**: {1-10}

**Issue**:
{Clear description of the coverage gap}

**Untested Code**:
```typescript
// This code at {file}:{line} is not tested
{untested code}
```

**Why This Matters**:
{Specific bugs or regressions this could miss:
- "If {scenario}, users would see {bad outcome}"
- "A future change to {X} could break {Y} without detection"}

---

#### Test Suggestions

| Option | Approach | Catches | Effort |
|--------|----------|---------|--------|
| A | {test approach} | {what it catches} | LOW/MED/HIGH |
| B | {alternative} | {what it catches} | LOW/MED/HIGH |

**Recommended**: Option {X}

**Reasoning**:
{Why this test approach:
- Matches codebase test patterns
- Tests behavior not implementation
- Good cost/benefit ratio
- Catches the most critical failures}

**Recommended Test**:
```typescript
describe('{feature}', () => {
  it('should {expected behavior}', () => {
    // Arrange
    {setup}

    // Act
    {action}

    // Assert
    {assertions}
  });

  it('should handle {edge case}', () => {
    // Test edge case
  });
});
```

**Test Pattern Reference**:
```typescript
// SOURCE: {test-file}:{lines}
// This is how similar functionality is tested
{existing test from codebase}
```

---

### Finding 2: {Title}

{Same structure...}

---

## Test Quality Audit

| Test | Tests Behavior | Resilient | Meaningful Assertions | Verdict |
|------|---------------|-----------|----------------------|---------|
| `it('should...')` | YES/NO | YES/NO | YES/NO | GOOD/NEEDS_WORK |
| ... | ... | ... | ... | ... |

---

## Statistics

| Severity | Count | Criticality 8-10 | Criticality 5-7 | Criticality 1-4 |
|----------|-------|------------------|-----------------|-----------------|
| CRITICAL | {n} | {n} | - | - |
| HIGH | {n} | {n} | {n} | - |
| MEDIUM | {n} | - | {n} | {n} |
| LOW | {n} | - | - | {n} |

---

## Risk Assessment

| Untested Area | Failure Mode | User Impact | Priority |
|---------------|--------------|-------------|----------|
| {code area} | {how it could fail} | {user sees} | CRITICAL/HIGH/MED |
| ... | ... | ... | ... |

---

## Patterns Referenced

| Test File | Lines | Pattern |
|-----------|-------|---------|
| `src/x.test.ts` | 10-30 | {testing pattern description} |
| ... | ... | ... |

---

## Positive Observations

{Good test coverage, well-written tests, proper mocking}

---

## Metadata

- **Agent**: test-coverage-agent
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/test-coverage-findings.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] Coverage map complete
- [ ] Each gap has criticality score
- [ ] Test suggestions with example code

---

## Success Criteria

- **COVERAGE_MAPPED**: Each source file mapped to tests
- **GAPS_IDENTIFIED**: Missing tests found with criticality scores
- **QUALITY_EVALUATED**: Existing tests assessed
- **TESTS_SUGGESTED**: Example test code provided for gaps
