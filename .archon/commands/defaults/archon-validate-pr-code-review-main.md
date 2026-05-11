---
description: Analyze code on the main/base branch to confirm the bug or gap exists before the PR's changes
argument-hint: (none - reads from artifacts)
---

# Code Review: Main Branch (Pre-PR State)

Analyze the codebase on the **main branch** to confirm that the bug, gap, or missing feature described in the PR actually exists.

---

## Phase 1: Load Context

### 1.1 Read PR Details

```bash
cat $ARTIFACTS_DIR/.pr-number
```

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
gh pr view "$PR_NUMBER" --json title,body,headRefName,baseRefName,labels
```

### 1.2 Read Path Information

```bash
cat $ARTIFACTS_DIR/.canonical-repo
cat $ARTIFACTS_DIR/.worktree-path
cat $ARTIFACTS_DIR/.pr-base
```

### 1.3 Understand What the PR Claims to Fix

From the PR title, body, and linked issue(s):
- What bug or gap does the PR claim exists?
- What is the expected behavior vs actual behavior?
- Which files/components are involved?

If the PR body references a GitHub issue, fetch it:

```bash
# Extract issue number from PR body (looks for "Fixes #N", "Closes #N", etc.)
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
ISSUE_NUMBER=$(gh pr view "$PR_NUMBER" --json body -q '.body' | grep -oE '(Fixes|Closes|Resolves)\s*#[0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -n "$ISSUE_NUMBER" ]; then
  gh issue view "$ISSUE_NUMBER" --json title,body,labels,comments
fi
```

---

## Phase 2: Analyze Main Branch Code

### 2.1 Read the Files That the PR Changes

Get the list of changed files from the PR diff, then read those **same files on the main branch** (the canonical repo path).

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n')
gh pr view "$PR_NUMBER" --json files -q '.files[].path'
```

**CRITICAL**: Read the files from the **canonical repo** (main branch), NOT from the current worktree (feature branch). The canonical repo path is in `$ARTIFACTS_DIR/.canonical-repo`.

For each changed file, read it from the main branch:

```bash
CANONICAL_REPO=$(cat $ARTIFACTS_DIR/.canonical-repo | tr -d '\n')
# Read each file from the canonical repo (on main branch)
cat "$CANONICAL_REPO/<file-path>"
```

### 2.2 Trace the Bug or Gap

For each claim in the PR:
1. **Find the relevant code** on main — read the specific functions, components, hooks
2. **Trace the data flow** — where does the data come from? How does it transform?
3. **Identify the root cause** — can you see the bug in the code?
4. **Check related code** — are there adjacent issues the PR might miss?

### 2.3 Assess Severity

- How impactful is this bug/gap on main?
- Is it user-facing or internal?
- Does it affect core functionality or edge cases?
- How likely is a user to encounter it?

---

## Phase 3: Write Findings

Write your analysis to `$ARTIFACTS_DIR/code-review-main.md`:

```markdown
# Main Branch Code Review: PR #{number}

**PR Title**: {title}
**Base Branch**: {base}
**Analyzed Commit**: {main branch HEAD}

## Bug/Gap Assessment

### Claimed Issue
{What the PR claims to fix}

### Confirmed on Main?
**YES / NO / PARTIAL**

### Evidence

{For each claim, provide specific code evidence:}

#### Claim 1: {description}
**Status**: Confirmed / Not Found / Partially Confirmed

**Code Location**: `{file}:{lines}`
```{language}
{actual code on main showing the bug/gap}
```

**Analysis**: {Why this code is buggy/incomplete}

#### Claim 2: {description}
{Same structure...}

### Related Issues Found
{Any additional problems discovered in the same code areas}

### Severity Assessment
| Factor | Rating |
|--------|--------|
| User Impact | High / Medium / Low |
| Frequency | Common / Uncommon / Rare |
| Core Feature | Yes / No |
| Data Loss Risk | Yes / No |

## Summary
{2-3 sentence summary: Is the bug real? How bad is it? Is the PR's scope appropriate?}
```

---

## Success Criteria

- **PR_CONTEXT_LOADED**: PR details and linked issue read
- **MAIN_CODE_ANALYZED**: Changed files read from main branch
- **BUG_ASSESSED**: Each PR claim verified against main branch code
- **ARTIFACT_WRITTEN**: `$ARTIFACTS_DIR/code-review-main.md` created
