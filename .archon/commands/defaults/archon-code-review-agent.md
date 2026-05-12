---
description: Review code quality, CLAUDE.md compliance, and detect bugs
argument-hint: (none - reads from scope artifact)
---

# Code Review Agent

---

## Your Mission

Review the PR for code quality, CLAUDE.md compliance, patterns, and bugs. Produce a structured artifact with findings, fix suggestions with multiple options, and reasoning.

**Output artifact**: `$ARTIFACTS_DIR/review/code-review-findings.md`

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

Note:
- Changed files list
- CLAUDE.md rules to check
- Focus areas

**CRITICAL**: Check for "NOT Building (Scope Limits)" section. Items listed there are **intentionally excluded** - do NOT flag them as bugs or missing features!

### 1.3 Get PR Diff

```bash
gh pr diff {number}
```

### 1.4 Read CLAUDE.md

```bash
cat CLAUDE.md
```

Note all coding standards, patterns, and rules.

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Scope loaded
- [ ] Diff available
- [ ] CLAUDE.md rules noted

---

## Phase 2: ANALYZE - Review Code

### 2.1 Check CLAUDE.md Compliance

For each changed file, verify:
- Import patterns match project style
- Naming conventions followed
- Error handling patterns correct
- Type annotations complete
- Testing patterns followed

### 2.2 Detect Bugs

Look for:
- Logic errors
- Null/undefined handling issues
- Race conditions
- Memory leaks
- Security vulnerabilities
- Off-by-one errors
- Missing error handling

### 2.3 Check Code Quality

Evaluate:
- Code duplication
- Function complexity
- Proper abstractions
- Clear naming
- Appropriate comments

### 2.4 Pattern Matching

For each issue found, search codebase for correct patterns:

```bash
# Find similar patterns in codebase
grep -r "pattern" src/ --include="*.ts" | head -5
```

### 2.5 Check for Primitive Duplication

For each new interface, class, type alias, or utility module introduced in the diff:

1. Search for similar existing abstractions:

```bash
# Replace {Name} with the new abstraction's name
grep -r "interface {Name}\|class {Name}\|type {Name}" packages/ --include="*.ts" | head -10
```

2. Flag if the new abstraction duplicates or closely overlaps an existing one.
3. Flag if a new utility function reimplements logic already available in a shared package.
4. Note findings in the CLAUDE.md Compliance section with verdict: **EXTENDS** (extends existing primitive) or **DUPLICATE** (redundant with existing) or **NEW** (genuinely new, no existing primitive).

**PHASE_2_CHECKPOINT:**
- [ ] CLAUDE.md compliance checked
- [ ] Bugs identified
- [ ] Quality issues noted
- [ ] Patterns found for fixes
- [ ] Primitive duplication checked

---

## Phase 3: GENERATE - Create Artifact

Write to `$ARTIFACTS_DIR/review/code-review-findings.md`:

```markdown
# Code Review Findings: PR #{number}

**Reviewer**: code-review-agent
**Date**: {ISO timestamp}
**Files Reviewed**: {count}

---

## Summary

{2-3 sentence overview of code quality and main concerns}

**Verdict**: {APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION}

---

## Findings

### Finding 1: {Descriptive Title}

**Severity**: CRITICAL | HIGH | MEDIUM | LOW
**Category**: bug | style | performance | security | pattern-violation
**Location**: `{file}:{line}`

**Issue**:
{Clear description of what's wrong}

**Evidence**:
```typescript
// Current code at {file}:{line}
{problematic code snippet}
```

**Why This Matters**:
{Explain the impact - what could go wrong, why it violates standards}

---

#### Fix Suggestions

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A | {approach description} | {benefits} | {drawbacks} |
| B | {alternative approach} | {benefits} | {drawbacks} |

**Recommended**: Option {A/B}

**Reasoning**:
{Explain why this option is preferred, referencing:
- Codebase patterns
- CLAUDE.md rules
- Best practices
- Specific project context}

**Recommended Fix**:
```typescript
// Suggested fix
{corrected code}
```

**Codebase Pattern Reference**:
```typescript
// SOURCE: {file}:{lines}
// This pattern shows how similar code is handled elsewhere
{existing code from codebase}
```

---

### Finding 2: {Title}

{Same structure...}

---

## Statistics

| Severity | Count | Auto-fixable |
|----------|-------|--------------|
| CRITICAL | {n} | {n} |
| HIGH | {n} | {n} |
| MEDIUM | {n} | {n} |
| LOW | {n} | {n} |

---

## CLAUDE.md Compliance

| Rule | Status | Notes |
|------|--------|-------|
| {rule from CLAUDE.md} | PASS/FAIL | {details} |
| ... | ... | ... |

---

## Patterns Referenced

| File | Lines | Pattern |
|------|-------|---------|
| `src/example.ts` | 42-50 | {what this pattern demonstrates} |
| ... | ... | ... |

---

## Positive Observations

{List things done well - good patterns, clean code, etc.}

---

## Metadata

- **Agent**: code-review-agent
- **Timestamp**: {ISO timestamp}
- **Artifact**: `$ARTIFACTS_DIR/review/code-review-findings.md`
```

**PHASE_3_CHECKPOINT:**
- [ ] Artifact file created
- [ ] All findings have severity and location
- [ ] Fix options provided with reasoning
- [ ] Codebase patterns referenced

---

## Phase 4: VALIDATE - Check Artifact

### 4.1 Verify File Exists

```bash
cat $ARTIFACTS_DIR/review/code-review-findings.md | head -20
```

### 4.2 Check Structure

Verify artifact contains:
- Summary with verdict
- At least findings section (even if empty)
- Statistics table
- CLAUDE.md compliance table

**PHASE_4_CHECKPOINT:**
- [ ] Artifact file exists
- [ ] Structure is complete
- [ ] No placeholder text remaining

---

## Success Criteria

- **CONTEXT_LOADED**: Scope and diff read successfully
- **ANALYSIS_COMPLETE**: All changed files reviewed
- **ARTIFACT_CREATED**: Findings file written
- **PATTERNS_INCLUDED**: Each finding references codebase patterns
- **OPTIONS_PROVIDED**: Multiple fix options where applicable
