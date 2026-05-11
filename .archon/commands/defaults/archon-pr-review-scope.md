---
description: Gather PR context, verify reviewability, and prepare artifacts directory for comprehensive review
argument-hint: <pr-number|url>
---

# PR Review Scope

**Input**: $ARGUMENTS

---

## Your Mission

Verify the PR is in a reviewable state, gather all context needed for the parallel review agents, and prepare the artifacts directory structure.

---

## Phase 1: IDENTIFY - Determine PR

### 1.1 Get PR Number

```bash
if [ -f "$ARTIFACTS_DIR/.pr-number" ]; then
  PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number | tr -d '\n' | tr -d ' ')
  if ! echo "$PR_NUMBER" | grep -qE '^[0-9]+$'; then
    PR_NUMBER=""
  fi
fi

# From arguments (standalone review)
if [ -z "$PR_NUMBER" ] && [ -n "$ARGUMENTS" ]; then
  PR_NUMBER=$(echo "$ARGUMENTS" | grep -oE '[0-9]+' | head -1)
fi

# From current branch
if [ -z "$PR_NUMBER" ]; then
  PR_NUMBER=$(gh pr view --json number -q '.number' 2>/dev/null)
fi

if [ -z "$PR_NUMBER" ]; then
  echo "ERROR: No PR number found"
  exit 1
fi

# Write to registry for downstream steps (if not already there)
echo "$PR_NUMBER" > $ARTIFACTS_DIR/.pr-number
```

### 1.2 Fetch PR Details

```bash
gh pr view {number} --json number,title,body,url,headRefName,baseRefName,files,additions,deletions,changedFiles,state,author,isDraft,mergeable,mergeStateStatus
```

**Extract:**
- PR number and title
- Branch names (head → base)
- Changed files list
- Addition/deletion counts
- Draft status
- Mergeable status

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] PR is open (not merged/closed)
- [ ] Basic metadata extracted

---

## Phase 2: VERIFY - Pre-Review Checks

**Before launching review agents, verify the PR is in a reviewable state.**

### 2.1 Check for Merge Conflicts

```bash
gh pr view {number} --json mergeable,mergeStateStatus --jq '.mergeable, .mergeStateStatus'
```

| Status | Action |
|--------|--------|
| `MERGEABLE` | Continue |
| `CONFLICTING` | **STOP** - Tell user to resolve conflicts first |
| `UNKNOWN` | Warn, continue (GitHub still calculating) |

**If conflicts exist:**
```markdown
❌ **Cannot review: PR has merge conflicts**

Please resolve conflicts before requesting a review:
```bash
git fetch origin {base}
git rebase origin/{base}
# Resolve conflicts
git push --force-with-lease
```

Then re-request the review.
```
**Exit workflow if conflicts detected.**

### 2.2 Check CI Status

```bash
gh pr checks {number} --json name,state,conclusion --jq '.[] | "\(.name): \(.state) (\(.conclusion // "pending"))"'
```

| Status | Action |
|--------|--------|
| All passing | Continue |
| Some failing | Warn, continue (note in scope) |
| All failing | Warn strongly, continue (note in scope) |
| Pending | Note, continue |

**Flag CI status for review report.**

### 2.3 Check Behind Base

```bash
# Get branch names
PR_BASE=$(gh pr view {number} --json baseRefName --jq '.baseRefName')
PR_HEAD=$(gh pr view {number} --json headRefName --jq '.headRefName')

# Fetch and count
git fetch origin $PR_BASE --quiet
git fetch origin $PR_HEAD --quiet

# Commits behind base branch
BEHIND=$(git rev-list --count origin/$PR_HEAD..origin/$PR_BASE 2>/dev/null || echo "0")
```

| Commits Behind | Action |
|----------------|--------|
| 0-5 | Continue |
| 6-15 | Warn, suggest rebase, continue |
| 16+ | Warn strongly, recommend rebase before review |

**If significantly behind:**
```markdown
⚠️ **Branch is {N} commits behind {base}**

Consider rebasing before review to ensure you're reviewing against current code:
```bash
git fetch origin {base}
git rebase origin/{base}
git push --force-with-lease
```
```

### 2.4 Check Draft Status

```bash
gh pr view {number} --json isDraft --jq '.isDraft'
```

| Status | Action |
|--------|--------|
| `false` | Continue normally |
| `true` | Note in scope, continue (user wants early feedback) |

### 2.5 Check PR Size

| Metric | Warning Threshold | Action |
|--------|-------------------|--------|
| Changed files | 20+ | Warn about review thoroughness |
| Lines changed | 1000+ | Warn about review thoroughness |

**If very large:**
```markdown
⚠️ **Large PR: {files} files, +{additions} -{deletions} lines**

Large PRs are harder to review thoroughly. Consider splitting into smaller PRs for better review quality.
```

### 2.6 Compile Reviewability Summary

```markdown
## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | ✅ None / ❌ Has conflicts | {details} |
| CI Status | ✅ Passing / ⚠️ Failing / ⏳ Pending | {details} |
| Behind Base | ✅ Up to date / ⚠️ {N} commits behind | {details} |
| Draft | ✅ Ready / 📝 Draft | {details} |
| Size | ✅ Normal / ⚠️ Large ({N} files) | {details} |
```

**PHASE_2_CHECKPOINT:**
- [ ] No merge conflicts (or workflow stopped)
- [ ] CI status noted
- [ ] Behind-base status checked
- [ ] Draft status noted
- [ ] Size warnings issued if needed

---

## Phase 3: CONTEXT - Gather Review Context

### 3.1 Get Full Diff

```bash
gh pr diff {number}
```

Store this for reference - parallel agents will re-fetch as needed.

### 3.2 List Changed Files by Type

```bash
gh pr view {number} --json files --jq '.files[].path'
```

**Categorize files:**
- Source code (`.ts`, `.js`, `.py`, etc.)
- Test files (`*.test.ts`, `*.spec.ts`, `test_*.py`)
- Documentation (`*.md`, `docs/`)
- Configuration (`.json`, `.yaml`, `.toml`)
- Types/interfaces

### 3.3 Check for CLAUDE.md

```bash
cat CLAUDE.md 2>/dev/null | head -100
```

Note key rules that reviewers should check against.

### 3.4 Identify New Abstractions

Scan the diff for new abstractions introduced by this PR:

- New interfaces, types, or abstract classes (search diff for `interface `, `type `, `abstract class`)
- New utility modules or helper files (new `.ts` files that aren't feature files or tests)
- New configuration keys or schema fields

For each new abstraction found, note it in the scope manifest under "Review Focus Areas" so the code review agent can verify it doesn't duplicate an existing primitive.

```bash
# Quick scan for new abstractions in diff
gh pr diff {number} | grep "^+" | sed 's/^+//' | grep -E "(^interface |^export interface |^type |^abstract class |^export class )" | head -20
```

**PHASE_3_CHECKPOINT:**
- [ ] Diff available
- [ ] Files categorized by type
- [ ] CLAUDE.md rules noted
- [ ] New abstractions scanned

---

## Phase 3.5: PLAN/ISSUE CONTEXT - Check for Workflow Artifacts

**CRITICAL**: If this PR was created by a workflow, there will be artifacts that contain important context for reviewers.

### 3.5.1 Find Workflow Artifacts

Check for artifacts from EITHER workflow type:

```bash
# Option 1: Plan-based workflow (archon-plan-to-merge)
ls -t $ARTIFACTS_DIR/../runs/*/plan-context.md 2>/dev/null | head -1

# Option 2: Issue-based workflow (archon-fix-github-issue)
ls -t $ARTIFACTS_DIR/../runs/*/investigation.md 2>/dev/null | head -1
```

### 3.5.2 Extract Scope Limits

**If plan-context.md exists** (from plan workflow):

```bash
# Extract the NOT Building section
sed -n '/## NOT Building/,/^## /p' $ARTIFACTS_DIR/../runs/*/plan-context.md | head -30
```

**If investigation.md exists** (from issue workflow):

```bash
# Extract the Scope Boundaries / OUT OF SCOPE section
sed -n '/## Scope Boundaries/,/^## /p' $ARTIFACTS_DIR/../runs/*/investigation.md | head -30
```

**These are INTENTIONAL exclusions** - do NOT flag them as bugs or missing features!

### 3.5.3 Check Implementation Report

```bash
# Look for implementation report (either workflow)
ls -t $ARTIFACTS_DIR/../runs/*/implementation.md 2>/dev/null | head -1
```

**If implementation.md exists**, note any deviations:

```bash
# Extract deviations section
sed -n '/## Deviations/,/^## /p' $ARTIFACTS_DIR/../runs/*/implementation.md | head -20
```

**PHASE_3.5_CHECKPOINT:**
- [ ] Workflow artifacts checked (plan-context.md OR investigation.md)
- [ ] Scope limits extracted (NOT Building OR OUT OF SCOPE)
- [ ] Implementation deviations noted (if available)

---

## Phase 4: PREPARE - Create Artifacts Directory

### 4.1 Create Directory Structure

```bash
mkdir -p $ARTIFACTS_DIR/review
```

### 4.2 Clean Stale Artifacts

```bash
# Remove review directories older than 7 days
find $ARTIFACTS_DIR/../reviews/pr-* -maxdepth 0 -mtime +7 -exec rm -rf {} \; 2>/dev/null || true
```

### 4.3 Create Scope Manifest

Write `$ARTIFACTS_DIR/review/scope.md`:

```markdown
# PR Review Scope: #{number}

**Title**: {PR title}
**URL**: {PR URL}
**Branch**: {head} → {base}
**Author**: {author}
**Date**: {ISO timestamp}

---

## Pre-Review Status

| Check | Status | Notes |
|-------|--------|-------|
| Merge Conflicts | {status} | {details} |
| CI Status | {status} | {passing}/{total} checks |
| Behind Base | {status} | {N} commits behind |
| Draft | {status} | {Ready/Draft} |
| Size | {status} | {files} files, +{add}/-{del} |

---

## Changed Files

| File | Type | Additions | Deletions |
|------|------|-----------|-----------|
| `src/file.ts` | source | +10 | -5 |
| `src/file.test.ts` | test | +20 | -0 |
| ... | ... | ... | ... |

**Total**: {changedFiles} files, +{additions} -{deletions}

---

## File Categories

### Source Files ({count})
- `src/...`

### Test Files ({count})
- `src/...test.ts`

### Documentation ({count})
- `$DOCS_DIR/...`
- `README.md`

### Configuration ({count})
- `package.json`

---

## Review Focus Areas

Based on changes, reviewers should focus on:

1. **Code Quality**: {list key source files}
2. **Error Handling**: {files with try/catch, error handling}
3. **Test Coverage**: {new functionality needing tests}
4. **Comments/Docs**: {files with documentation changes}
5. **Docs Impact**: {check if CLAUDE.md or $DOCS_DIR need updates}
6. **Primitive Alignment**: {If new abstractions found: list them} — verify no duplication of existing primitives

---

## CLAUDE.md Rules to Check

{Extract key rules from CLAUDE.md that apply to this PR}

---

## Workflow Context (if from automated workflow)

{If plan-context.md OR investigation.md was found:}

### Scope Limits (NOT Building / OUT OF SCOPE)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

{From plan-context.md "NOT Building" section OR investigation.md "Scope Boundaries/OUT OF SCOPE" section}

**IN SCOPE:**
- {what we're changing}

**OUT OF SCOPE (do not touch):**
- {Explicit exclusion 1 with rationale}
- {Explicit exclusion 2 with rationale}

### Implementation Deviations

{If implementation.md was found and has deviations:}

{Copy the "Deviations" section from implementation.md}

{If no workflow artifacts found:}

_No workflow artifacts found - this appears to be a manual PR._

---

## CI Details

{If CI failing, list which checks failed}

---

## Metadata

- **Scope created**: {ISO timestamp}
- **Artifact path**: `$ARTIFACTS_DIR/review/`
```

**PHASE_4_CHECKPOINT:**
- [ ] Directory created
- [ ] Stale artifacts cleaned
- [ ] Scope manifest written with pre-review status

---

## Phase 5: OUTPUT - Report to User

### If Blocked (Conflicts)

```markdown
## ❌ Review Blocked: Merge Conflicts

**PR**: #{number} - {title}

This PR has merge conflicts that must be resolved before review.

### To Resolve

```bash
git fetch origin {base}
git checkout {head}
git rebase origin/{base}
# Resolve conflicts in your editor
git add .
git rebase --continue
git push --force-with-lease
```

Then re-request the review: `@archon review this PR`
```

### If Proceeding

```markdown
## PR Review Scope Complete

**PR**: #{number} - {title}
**Files**: {count} changed (+{additions} -{deletions})

### Pre-Review Status
| Check | Status |
|-------|--------|
| Conflicts | ✅ None |
| CI | {✅ Passing / ⚠️ {N} failing} |
| Behind Base | {✅ Up to date / ⚠️ {N} behind} |
| Draft | {✅ Ready / 📝 Draft} |
| Size | {✅ Normal / ⚠️ Large} |

### File Categories
- Source: {count} files
- Tests: {count} files
- Docs: {count} files
- Config: {count} files

### Artifacts Directory
`$ARTIFACTS_DIR/review/`

### Next Step
Launching 5 parallel review agents...
```

---

## Success Criteria

- **PR_IDENTIFIED**: Valid open PR found
- **NO_CONFLICTS**: Merge conflicts block workflow
- **CONTEXT_GATHERED**: Diff and file list available
- **ARTIFACTS_DIR_CREATED**: Directory structure exists
- **SCOPE_MANIFEST_WRITTEN**: `scope.md` file created with pre-review status
