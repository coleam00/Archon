---
description: Analyze and document root cause for a GitHub issue
argument-hint: "[github-issue-id]"
---

# Root Cause Analysis: GitHub Issue #$ARGUMENTS

## Objective

Investigate GitHub issue #$ARGUMENTS from this repository, identify the root cause, and document findings for implementation.

**Prerequisites:**
- Working in a local Git repository with GitHub origin
- GitHub CLI installed and authenticated (`gh auth status`)
- Valid GitHub issue ID from this repository

## Investigation Process

### 1. Fetch GitHub Issue Details

```bash
gh issue view $ARGUMENTS
```

Extract: title, description, labels, status, comments, reproduction steps.

### 2. Search Codebase

Use subagents for parallel investigation:

**Identify relevant code:**
- Search for components, functions, and modules mentioned in issue
- Trace the code path that would trigger the reported behavior
- Check related files across package boundaries

**Key areas to investigate based on issue type:**
- Platform adapter issues → `packages/adapters/`
- Workflow execution → `packages/workflows/`
- UI/frontend → `packages/web/`
- Session/conversation state → `packages/core/src/state/`, `packages/core/src/db/`
- Git/isolation → `packages/isolation/`, `packages/git/`
- API/server → `packages/server/`

### 3. Review Recent History

Check recent changes to affected areas:
```bash
git log --oneline -20 -- [relevant-paths]
```

Look for:
- Recent modifications that may have introduced the issue
- Related bug fixes
- Refactorings that might have changed behavior

### 4. Investigate Root Cause

**Analyze the code to determine:**
- What is the actual bug or issue?
- Why is it happening? (5 Whys analysis)
- Is this a logic error, edge case, race condition, or missing validation?
- Does it cross package boundaries?
- Are there related issues or symptoms?

**Archon-specific considerations:**
- Session state machine transitions — is a transition trigger missing?
- Mock.module() test isolation — could test pollution mask the issue?
- SSE streaming — could event ordering or connection drops cause this?
- ConversationLockManager — could concurrency be involved?
- Worktree isolation — is the issue environment-specific?

### 5. Assess Impact

- How widespread is this issue?
- What platforms/adapters are affected?
- Are there workarounds?
- What is the severity? (P0-P3)
- Could this cause data corruption or silent failures?

### 6. Propose Fix Approach

- What needs to be changed?
- Which packages and files will be modified?
- What is the fix strategy?
- Are there alternative approaches?
- What validation is needed?

## Output: Create RCA Document

Save analysis as: `.agents/rca/issue-$ARGUMENTS.md`

### Required Structure

```markdown
# Root Cause Analysis: GitHub Issue #$ARGUMENTS

## Issue Summary
- **GitHub Issue ID**: #$ARGUMENTS
- **Title**: [Issue title]
- **Severity**: [P0/P1/P2/P3]
- **Affected Packages**: [list of @archon/* packages]

## Problem Description
[Clear description]

**Expected Behavior:** [what should happen]
**Actual Behavior:** [what actually happens]

## Root Cause

### Affected Components
- **Files**: [list with full paths]
- **Functions**: [specific code locations with file:line]
- **Packages**: [which @archon/* packages are involved]

### Analysis
[Detailed explanation with code references]

**Code Location:**
[File path:line number with relevant code snippet]

## Impact Assessment
- **Scope**: [how widespread]
- **Affected Features**: [list]
- **Severity Justification**: [why this severity level]

## Proposed Fix

### Fix Strategy
[High-level approach]

### Files to Modify
1. **[file-path]**
   - Changes: [what needs to change]
   - Reason: [why this change fixes it]

### Testing Requirements
1. [Test case 1 - verify fix]
2. [Test case 2 - no regression]
3. [Test case 3 - edge cases]

### Validation Commands
bun run type-check
bun run lint
bun run test
bun run validate

## Next Steps
1. Review this RCA document
2. Run: `/implement-fix $ARGUMENTS` to implement the fix
3. Run: `/commit` after implementation complete
```
