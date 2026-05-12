---
description: Sync PR branch with latest main (rebase if needed, resolve conflicts if any)
argument-hint: (none - uses PR from scope)
---

# Sync PR with Main

---

## Your Mission

Ensure the PR branch is up-to-date with the latest main branch before review. Rebase if needed, resolve conflicts if any arise. This step is silent when no action is needed.

**Output artifact**: `$ARTIFACTS_DIR/review/sync-report.md` (only if rebase/conflicts occurred)

---

## Phase 1: CHECK - Determine if Sync Needed

### 1.1 Get PR Number from Registry

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### 1.2 Read Scope

```bash
cat $ARTIFACTS_DIR/review/scope.md
```

Get branch names: `PR_HEAD` and `PR_BASE`.

### 1.3 Fetch and Checkout PR Branch

```bash
git fetch origin $PR_BASE
git fetch origin $PR_HEAD
```

Confirm you are on the PR's branch (`$PR_HEAD`). If not, checkout it:

```bash
git checkout $PR_HEAD
```

### 1.4 Check if Behind

```bash
# Count commits PR branch is behind main
BEHIND=$(git rev-list --count HEAD..origin/$PR_BASE)
echo "Behind by: $BEHIND commits"
```

**Decision:**

| Behind Count | Action |
|--------------|--------|
| 0 | Skip - already up to date |
| 1+ | Rebase needed |

**If already up to date:**
```markdown
Branch is up to date with `{base}`. No sync needed.
```
**Exit early - no artifact created.**

**PHASE_1_CHECKPOINT:**
- [ ] PR number identified
- [ ] Branches fetched
- [ ] Behind count determined

---

## Phase 2: REBASE - Sync with Main

### 2.1 Attempt Rebase

```bash
git rebase origin/$PR_BASE
```

**Possible outcomes:**

| Result | Next Step |
|--------|-----------|
| Success (no conflicts) | Go to Phase 4 (Validate) |
| Conflicts | Go to Phase 3 (Resolve) |
| Other error | Report and abort |

### 2.2 Check for Conflicts

```bash
# If rebase stopped, check for conflicts
git diff --name-only --diff-filter=U
```

If files listed → conflicts exist, go to Phase 3.
If empty → rebase successful, go to Phase 4.

**PHASE_2_CHECKPOINT:**
- [ ] Rebase attempted
- [ ] Conflict status determined

---

## Phase 3: RESOLVE - Handle Conflicts (If Any)

### 3.1 Identify Conflicting Files

```bash
git diff --name-only --diff-filter=U
```

### 3.2 Analyze Each Conflict

For each conflicting file:

```bash
# Show conflict markers
cat {file} | grep -A 10 -B 2 "<<<<<<<"
```

**Categorize:**
- **SIMPLE**: One side added/changed, other didn't touch → Auto-resolve
- **COMPLEX**: Both sides changed same lines → Need decision

### 3.3 Auto-Resolve Simple Conflicts

For conflicts where intent is clear:
- Both added different things → Keep both
- One updated, other didn't → Keep update
- Import additions → Merge both

```bash
# Edit file to resolve
# Then stage
git add {file}
```

### 3.4 Resolve Complex Conflicts

For conflicts needing decision:

1. Read both versions to understand intent
2. Choose resolution based on:
   - PR intent (what was the change trying to do?)
   - Base branch updates (what changed in main?)
   - Code correctness
3. Apply resolution and stage

```bash
git add {file}
```

### 3.5 Continue Rebase

```bash
git rebase --continue
```

Repeat if more commits have conflicts.

**PHASE_3_CHECKPOINT:**
- [ ] All conflicts identified
- [ ] Simple conflicts auto-resolved
- [ ] Complex conflicts resolved with reasoning
- [ ] Rebase completed

---

## Phase 4: VALIDATE - Verify Sync

### 4.1 Check No Conflicts Remaining

```bash
git diff --check
```

Should return empty.

### 4.2 Type Check

```bash
bun run type-check
```

### 4.3 Run Tests

```bash
bun test
```

### 4.4 Lint

```bash
bun run lint
```

**If any fail**: Fix issues before proceeding.

**PHASE_4_CHECKPOINT:**
- [ ] No conflict markers
- [ ] Type check passes
- [ ] Tests pass
- [ ] Lint passes

---

## Phase 5: PUSH - Update Remote

### 5.1 Confirm Branch and Push

Confirm you're on `$PR_HEAD`, then push:

```bash
git push --force-with-lease origin $PR_HEAD
```

**Note**: `--force-with-lease` is safer - fails if someone else pushed.

### 5.2 Verify Push

```bash
git log origin/$PR_HEAD --oneline -3
```

Confirm local and remote match.

**PHASE_5_CHECKPOINT:**
- [ ] Branch pushed
- [ ] Remote updated

---

## Phase 6: REPORT - Document Sync (Only if Rebase/Conflicts Occurred)

### 6.1 Create Sync Artifact

Write to `$ARTIFACTS_DIR/review/sync-report.md`:

```markdown
# Sync Report: PR #{number}

**Date**: {ISO timestamp}
**Action**: Rebased onto `{base}`

---

## Summary

- **Commits rebased**: {N}
- **Conflicts resolved**: {M} (in {X} files)
- **Status**: ✅ Synced successfully

---

## Conflicts Resolved

{If conflicts were resolved:}

### `{file}`

**Type**: {SIMPLE | COMPLEX}
**Resolution**: {description}

```{language}
{resolved code}
```

---

{If no conflicts:}

No conflicts encountered during rebase.

---

## Validation

| Check | Status |
|-------|--------|
| Type check | ✅ |
| Tests | ✅ |
| Lint | ✅ |

---

## Git State

**Before**: {old HEAD commit}
**After**: {new HEAD commit}
**Commits ahead of {base}**: {count}

---

## Metadata

- **Synced by**: Archon
- **Timestamp**: {ISO timestamp}
```

### 6.2 Update Scope Artifact

Append to `$ARTIFACTS_DIR/review/scope.md`:

```markdown
---

## Sync Status

**Synced**: {ISO timestamp}
**Rebased onto**: `{base}` at {commit}
**Conflicts resolved**: {N}
```

**PHASE_6_CHECKPOINT:**
- [ ] Sync artifact created (if action taken)
- [ ] Scope artifact updated

---

## Phase 7: OUTPUT - Report Status

### If Rebased (with or without conflicts):

```markdown
## ✅ PR Synced with Main

**Branch**: `{head}` rebased onto `{base}`
**Commits rebased**: {N}
**Conflicts resolved**: {M}

Validation: ✅ Type check | ✅ Tests | ✅ Lint

Proceeding to parallel review...
```

### If Already Up to Date:

```markdown
## ✅ PR Already Up to Date

Branch `{head}` is current with `{base}`. No sync needed.

Proceeding to parallel review...
```

### If Sync Failed:

```markdown
## ❌ Sync Failed

**Error**: {description}

**Action Required**: Manual intervention needed.

```bash
# To abort the failed rebase
git rebase --abort
```

**Recommendation**: Resolve conflicts manually, then re-trigger review.
```

---

## Error Handling

### Rebase Fails Completely

```bash
git rebase --abort
```

Report failure with specific error.

### Push Rejected

If `--force-with-lease` fails:
1. Someone else pushed to the branch
2. Fetch and re-attempt rebase
3. Or report for manual handling

### Validation Fails

If type-check/tests fail after rebase:
1. Investigate which changes broke
2. Attempt to fix
3. If unfixable, abort and report

---

## Success Criteria

- **UP_TO_DATE**: Branch is synced with base (or was already)
- **NO_CONFLICTS**: All conflicts resolved (if any existed)
- **VALIDATION_PASSED**: Type check, tests, lint all pass
- **PUSHED**: Remote branch updated (if rebase occurred)
