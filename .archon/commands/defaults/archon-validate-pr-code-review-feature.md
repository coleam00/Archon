---
description: Analyze code on the feature branch to verify the PR's fix is correct and optimal
argument-hint: (none - reads from artifacts)
---

# Code Review: Feature Branch (Post-PR State)

Analyze the code changes in the PR to verify the fix is correct, complete, and implemented in the best way possible.

---

## Phase 1: Load Context

### 1.1 Read PR Details and Main Branch Analysis

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
gh pr view "$PR_NUMBER" --json title,body,headRefName,baseRefName,labels
```

```bash
# Read the main branch analysis (guaranteed available — this node depends on code-review-main)
cat $ARTIFACTS_DIR/code-review-main.md
```

### 1.2 Read Path Information

```bash
cat $ARTIFACTS_DIR/.worktree-path
cat $ARTIFACTS_DIR/.feature-branch
```

---

## Phase 2: Analyze the Diff

### 2.1 Get the Full Diff

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
gh pr diff "$PR_NUMBER"
```

### 2.2 Read Changed Files on Feature Branch

The current working directory IS the feature branch (worktree). Read each changed file:

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
# List changed files
gh pr view "$PR_NUMBER" --json files -q '.files[].path'
```

For each file, read the full file in the current working directory to understand the complete context, not just the diff hunks.

### 2.3 Deep Analysis of Each Change

For each changed file:

1. **Read the full file** — understand the complete context around the changes
2. **Compare with main** — read the same file from `$ARTIFACTS_DIR/.canonical-repo` to see the before/after
3. **Evaluate the fix**:
   - Does it actually address the bug/gap found on main?
   - Is it the simplest possible fix? (KISS)
   - Does it handle edge cases?
   - Could it introduce new bugs?
   - Does it follow existing patterns in the codebase?
4. **Check CLAUDE.md compliance**:
   ```bash
   cat CLAUDE.md
   ```
   - Import patterns correct?
   - Type annotations complete?
   - Error handling appropriate?
   - No unnecessary complexity?

### 2.4 Look for Issues

Check for:
- **Correctness**: Does the fix actually solve the problem?
- **Completeness**: Are all aspects of the bug addressed?
- **Side effects**: Could this break something else?
- **Performance**: Any unnecessary re-renders, expensive operations?
- **Type safety**: All types correct, no `any` without justification?
- **Error handling**: Errors caught and handled appropriately?
- **Overengineering**: More changes than necessary? (YAGNI)
- **Missing changes**: Files that SHOULD have been changed but weren't?

### 2.5 Compare Alternative Approaches

Think about whether there's a better way to fix this:
- Could a simpler approach work?
- Is there an existing utility/pattern that should be used?
- Would the fix work differently if applied at a different layer?

---

## Phase 3: Write Findings

Write your analysis to `$ARTIFACTS_DIR/code-review-feature.md`:

```markdown
# Feature Branch Code Review: PR #{number}

**PR Title**: {title}
**Feature Branch**: {branch}
**Files Changed**: {count}
**Lines**: +{additions} -{deletions}

## Fix Assessment

### Does the Fix Address the Bug?
**YES / PARTIALLY / NO**

{Explanation with specific code references}

### Fix Quality

| Criterion | Rating (1-5) | Notes |
|-----------|-------------|-------|
| Correctness | {n} | {does it fix the bug?} |
| Completeness | {n} | {all edge cases handled?} |
| Simplicity | {n} | {minimal changes, KISS?} |
| Safety | {n} | {no side effects?} |
| Patterns | {n} | {follows codebase conventions?} |

**Overall Score**: {average}/5

### File-by-File Analysis

#### `{file1}`
**Change Summary**: {what changed}
**Assessment**: {good/needs-work/concern}
```{language}
// Key change
{relevant code snippet}
```
**Notes**: {specific feedback}

#### `{file2}`
{Same structure...}

### Issues Found

#### Issue 1: {title}
**Severity**: CRITICAL / HIGH / MEDIUM / LOW
**File**: `{file}:{line}`
**Description**: {what's wrong}
**Suggested Fix**:
```{language}
{how to fix it}
```

### Alternative Approaches Considered
{Were there better ways to implement this? If so, describe them and why they might be preferable.
If the current approach is optimal, say so and explain why.}

### Missing Changes
{Files or areas that should have been changed but weren't. If everything is covered, say so.}

## CLAUDE.md Compliance

| Rule | Status | Notes |
|------|--------|-------|
| Type annotations | PASS/FAIL | {details} |
| Import patterns | PASS/FAIL | {details} |
| Error handling | PASS/FAIL | {details} |
| No any types | PASS/FAIL | {details} |
| KISS principle | PASS/FAIL | {details} |

## Verdict

**APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION**

{2-3 sentence final assessment: Is this fix ready to merge as-is?}
```

---

## Success Criteria

- **DIFF_ANALYZED**: Full PR diff reviewed
- **FILES_READ**: All changed files read in full context
- **MAIN_COMPARED**: Feature code compared against main branch code
- **CLAUDE_MD_CHECKED**: CLAUDE.md compliance verified
- **ARTIFACT_WRITTEN**: `$ARTIFACTS_DIR/code-review-feature.md` created
