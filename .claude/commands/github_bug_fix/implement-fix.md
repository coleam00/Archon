---
description: Implement fix from RCA document for GitHub issue
argument-hint: "[github-issue-id]"
---

# Implement Fix: GitHub Issue #$ARGUMENTS

## Prerequisites

- RCA document exists at `.agents/rca/issue-$ARGUMENTS.md`
- If not, run `/rca $ARGUMENTS` first

## RCA Document to Reference

Read RCA: `.agents/rca/issue-$ARGUMENTS.md`

**Optional — View GitHub issue for latest context:**
```bash
gh issue view $ARGUMENTS
```

## Implementation Instructions

### 1. Read and Understand RCA

- Read the ENTIRE RCA document thoroughly
- Understand the root cause
- Review the proposed fix strategy
- Note all files to modify
- Review testing requirements

### 2. Verify Current State

Before making changes:
- Confirm the issue still exists in current code
- Check current state of affected files
- Review any recent changes to those files since RCA was written

### 3. Implement the Fix

Following the "Proposed Fix" section of the RCA:

**For each file to modify:**

#### a. Read the existing file
- Understand current implementation
- Locate the specific code mentioned in RCA

#### b. Make the fix
- Implement the change as described
- Follow the fix strategy exactly
- Maintain Archon coding conventions (see CLAUDE.md)
- Respect package boundaries
- Use proper import patterns (`import type` for type-only)

#### c. Handle related changes
- Update related code affected by the fix
- Ensure consistency across packages
- Update imports if needed

### 4. Add/Update Tests

Following the "Testing Requirements" from RCA:

**Important Archon test patterns:**
- Use `spyOn()` for internal module mocking (not `mock.module()` unless absolutely necessary)
- If adding `mock.module()`, check if the test file needs its own batch in package.json
- Place tests alongside source files or in existing test directories
- Follow existing test patterns in the affected package

### 5. Run Validation

```bash
bun run type-check
bun run lint
bun run test
bun run validate
```

**If validation fails:**
- Fix the issues
- Re-run validation
- Don't proceed until all pass

### 6. Verify Fix Manually

If applicable:
- Follow reproduction steps from RCA
- Confirm issue no longer occurs
- Test edge cases
- Check for unintended side effects

## Output Report

### Fix Implementation Summary

**GitHub Issue #$ARGUMENTS**: [Brief title]

**Root Cause** (from RCA):
[One-line summary]

### Changes Made

**Files Modified:**
1. **[file-path]**
   - Change: [what was changed]
   - Lines: [line numbers]

### Tests Added

**Test Files Created/Modified:**
1. **[test-file-path]**
   - Test cases: [list test functions]
   - Mock isolation: [notes on mock.module() vs spyOn()]

### Validation Results

```
Type Checking:  ✅/❌
Linting:        ✅/❌
Formatting:     ✅/❌
Tests:          ✅/❌ [X passed]
Full Validate:  ✅/❌
```

### Ready for Commit

All changes complete and validated. Ready for:
```bash
/commit
```

**Suggested commit message:**
```
fix([package]): resolve GitHub issue #$ARGUMENTS - [brief description]

[Summary of what was fixed and how]

Fixes #$ARGUMENTS
```

### Optional: Update GitHub Issue

```bash
gh issue comment $ARGUMENTS --body "Fix implemented. Ready for review."
```

## Notes

- If the RCA document is missing, request it with `/rca $ARGUMENTS`
- If you discover the RCA analysis was incorrect, document findings and update the RCA
- If additional issues are found during implementation, note them for separate issues
- Follow Archon coding standards exactly (CLAUDE.md + relevant .claude/rules/)
