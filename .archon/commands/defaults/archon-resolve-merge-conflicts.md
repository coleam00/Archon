---
description: Analyze and resolve merge conflicts in a PR
argument-hint: <pr-number|url>
---

# Resolve Merge Conflicts

**Input**: $ARGUMENTS

---

## Your Mission

Analyze merge conflicts in the PR, automatically resolve simple conflicts where intent is clear, present options for complex conflicts, and push the resolution.

---

## Phase 1: IDENTIFY - Get PR and Conflict Info

### 1.1 Parse Input

**Check input format:**
- Number (`123`, `#123`) → GitHub PR number
- URL (`https://github.com/...`) → Extract PR number
- Empty → Check current branch for open PR

```bash
gh pr view {number} --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus
```

### 1.2 Verify Conflicts Exist

```bash
gh pr view {number} --json mergeable,mergeStateStatus --jq '.mergeable, .mergeStateStatus'
```

| Status | Action |
|--------|--------|
| `CONFLICTING` | Continue with resolution |
| `MERGEABLE` | Report "No conflicts to resolve" and exit |
| `UNKNOWN` | Wait and retry, or proceed with caution |

**If no conflicts:**
```markdown
## ✅ No Conflicts

PR #{number} has no merge conflicts. It's ready for review/merge.
```
**Exit if no conflicts.**

### 1.3 Setup Local Branch

```bash
# Get branch info
PR_HEAD=$(gh pr view {number} --json headRefName --jq '.headRefName')
PR_BASE=$(gh pr view {number} --json baseRefName --jq '.baseRefName')

# Fetch latest
git fetch origin $PR_BASE
git fetch origin $PR_HEAD

# Checkout the PR branch
git checkout $PR_HEAD
git pull origin $PR_HEAD
```

**PHASE_1_CHECKPOINT:**
- [ ] PR identified with conflicts
- [ ] Branches fetched
- [ ] On PR branch locally

---

## Phase 2: ANALYZE - Understand the Conflicts

### 2.1 Attempt Rebase to Surface Conflicts

```bash
git rebase origin/$PR_BASE
```

This will stop at the first conflict. Note the output.

### 2.2 Identify Conflicting Files

```bash
git diff --name-only --diff-filter=U
```

List all files with conflicts.

### 2.3 Analyze Each Conflict

For each conflicting file:

```bash
# Show the conflict markers
git diff --check
cat {file} | grep -A 10 -B 2 "<<<<<<<"
```

**Categorize each conflict:**

| Type | Description | Auto-resolvable? |
|------|-------------|------------------|
| **SIMPLE_ADDITION** | One side added, other didn't change that area | ✅ Yes |
| **SIMPLE_DELETION** | One side deleted, other didn't change | ⚠️ Maybe (check intent) |
| **DIFFERENT_AREAS** | Both changed but different lines | ✅ Yes |
| **SAME_LINES** | Both changed the exact same lines | ❌ No - needs decision |
| **STRUCTURAL** | File moved/renamed + modified | ❌ No - needs decision |

### 2.4 Read Both Versions

For complex conflicts, understand what each side was trying to do:

```bash
# Show base version (common ancestor)
git show :1:{file} 2>/dev/null || echo "File didn't exist in base"

# Show "ours" version (HEAD/current branch)
git show :2:{file}

# Show "theirs" version (incoming from base branch)
git show :3:{file}
```

**PHASE_2_CHECKPOINT:**
- [ ] All conflicting files identified
- [ ] Each conflict categorized
- [ ] Both sides' intent understood

---

## Phase 3: RESOLVE - Fix the Conflicts

### 3.1 Auto-Resolve Simple Conflicts

For conflicts where intent is clear:

```bash
# For each auto-resolvable file
# Edit to keep both changes (if both are additive)
# Or keep the appropriate side based on intent
```

**Auto-resolution rules:**
1. **Both added different things**: Keep both additions
2. **One updated, one didn't touch**: Keep the update
3. **Import additions**: Merge both import lists
4. **Comment changes**: Prefer the more informative version

### 3.2 Present Options for Complex Conflicts

For conflicts that need human decision:

```markdown
## Conflict in `{file}`

**Lines {start}-{end}**

### Option A: Keep PR Changes (HEAD)
```{language}
{code from PR branch}
```

**What this does**: {explanation of PR's intent}

### Option B: Keep Base Branch Changes
```{language}
{code from base branch}
```

**What this does**: {explanation of base branch's intent}

### Option C: Merge Both (Recommended if compatible)
```{language}
{merged version if possible}
```

**Why**: {explanation of why this merge makes sense}

### Option D: Custom Resolution Needed
The changes are incompatible. Manual review required.

---

**Recommendation**: Option {X}

**Reasoning**: {why this option based on:
- Code functionality
- PR intent from title/description
- Which change is more recent/complete
- Impact on other code}
```

### 3.3 Apply Resolutions

For each conflict:

1. **If auto-resolvable**: Apply the resolution
2. **If needs decision**: Use recommended option (or ask user if unclear)

```bash
# After editing each file
git add {file}
```

### 3.4 Continue Rebase

```bash
# After resolving all conflicts in current commit
git rebase --continue
```

Repeat for any additional conflicting commits.

**PHASE_3_CHECKPOINT:**
- [ ] All simple conflicts auto-resolved
- [ ] Complex conflicts resolved with documented reasoning
- [ ] All files staged
- [ ] Rebase completed

---

## Phase 4: VALIDATE - Verify Resolution

### 4.1 Check No Remaining Conflicts

```bash
git diff --check
```

Should return empty (no conflict markers remaining).

### 4.2 Verify Code Compiles

```bash
bun run type-check
```

If type errors related to resolution, fix them.

### 4.3 Run Tests

```bash
bun test
```

If tests fail due to resolution, investigate and fix.

### 4.4 Lint Check

```bash
bun run lint
```

Fix any lint issues.

**PHASE_4_CHECKPOINT:**
- [ ] No conflict markers remaining
- [ ] Type check passes
- [ ] Tests pass
- [ ] Lint passes

---

## Phase 5: PUSH - Update the PR

### 5.1 Force Push the Resolved Branch

```bash
git push --force-with-lease origin $PR_HEAD
```

**Note**: `--force-with-lease` is safer than `--force` as it fails if someone else pushed.

### 5.2 Verify PR is Now Mergeable

```bash
gh pr view {number} --json mergeable,mergeStateStatus
```

Should show `MERGEABLE`.

**PHASE_5_CHECKPOINT:**
- [ ] Branch pushed successfully
- [ ] PR shows as mergeable

---

## Phase 6: REPORT - Document Resolution

### 6.1 Create Resolution Artifact

Write to `$ARTIFACTS_DIR/../reviews/pr-{number}/conflict-resolution.md` (create dir if needed):

```markdown
# Conflict Resolution: PR #{number}

**Date**: {ISO timestamp}
**Branch**: {head} rebased onto {base}

---

## Summary

Resolved {N} conflicts in {M} files.

---

## Conflicts Resolved

### File: `{file1}`

**Conflict Type**: {SIMPLE_ADDITION | SAME_LINES | etc.}
**Resolution**: {Auto-resolved | Option A/B/C chosen}

**Before (conflict)**:
```{language}
<<<<<<< HEAD
{head version}
=======
{base version}
>>>>>>> {base}
```

**After (resolved)**:
```{language}
{final code}
```

**Reasoning**: {why this resolution}

---

### File: `{file2}`

{Same structure...}

---

## Validation

| Check | Status |
|-------|--------|
| No conflict markers | ✅ |
| Type check | ✅ |
| Tests | ✅ |
| Lint | ✅ |

---

## Git Log

```
{git log --oneline -5}
```

---

## Metadata

- **Resolved by**: Archon
- **Timestamp**: {ISO timestamp}
```

### 6.2 Post GitHub Comment

```bash
gh pr comment {number} --body "$(cat <<'EOF'
## ✅ Conflicts Resolved

**Rebased onto**: `{base}`
**Conflicts resolved**: {N} in {M} files

### Resolution Summary

| File | Conflict Type | Resolution |
|------|---------------|------------|
| `{file1}` | {type} | {resolution approach} |
| `{file2}` | {type} | {resolution approach} |

### Validation
✅ Type check | ✅ Tests | ✅ Lint

### Details
See `$ARTIFACTS_DIR/../reviews/pr-{number}/conflict-resolution.md` for full resolution details.

---
*Resolved by Archon resolve-conflicts workflow*
EOF
)"
```

**PHASE_6_CHECKPOINT:**
- [ ] Artifact created
- [ ] GitHub comment posted

---

## Phase 7: OUTPUT - Final Report

```markdown
## ✅ Conflicts Resolved

**PR**: #{number} - {title}
**Branch**: `{head}` rebased onto `{base}`

### Summary
- **Files with conflicts**: {M}
- **Conflicts resolved**: {N}
- **Auto-resolved**: {X}
- **Manual decisions**: {Y}

### Resolution Details

| File | Type | Resolution |
|------|------|------------|
| `{file}` | {type} | {approach} |

### Validation
| Check | Status |
|-------|--------|
| Type check | ✅ |
| Tests | ✅ |
| Lint | ✅ |

### Artifacts
- Resolution details: `$ARTIFACTS_DIR/../reviews/pr-{number}/conflict-resolution.md`

### Next Steps
1. Review the resolution if needed: `git log -p -1`
2. PR is now ready for review
3. Request review: `@archon review this PR`
```

---

## Error Handling

### Rebase Fails Mid-way

If rebase fails on a commit that can't be resolved:

```bash
# Check status
git status

# If truly stuck, abort and report
git rebase --abort
```

Report the failure with details about which commit and why.

### Push Fails

If `--force-with-lease` fails (someone else pushed):

1. Fetch latest
2. Re-analyze conflicts
3. Start over

### Validation Fails After Resolution

If type-check/tests fail after resolution:

1. Investigate which resolution caused the issue
2. Try alternative resolution
3. If stuck, report and suggest manual review

---

## Success Criteria

- **CONFLICTS_IDENTIFIED**: All conflicting files found
- **CONFLICTS_RESOLVED**: All conflicts resolved (auto or manual)
- **VALIDATION_PASSED**: Type check, tests, lint all pass
- **BRANCH_PUSHED**: PR branch updated with resolution
- **PR_MERGEABLE**: GitHub shows PR as mergeable
- **DOCUMENTED**: Resolution artifact and GitHub comment created
