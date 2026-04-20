---
description: Implement a fix from investigation artifact - code changes, PR, and self-review
argument-hint: <issue-number|artifact-path>
---

# Implement Issue

**Input**: $ARGUMENTS

---

## Your Mission

Execute the implementation plan from `/investigate-issue`:

1. Load and validate the artifact
2. Ensure git state is correct
3. Discover and install dependencies in the worktree
4. Implement the changes exactly as specified
5. Run validation
6. Create PR linked to issue
7. Run self-review and post findings
8. Archive the artifact

**Golden Rule**: Follow the artifact. If something seems wrong, validate it first - don't silently deviate.

---

## Phase 1: LOAD - Get the Artifact

### 1.1 Find Investigation Artifact

Look for the investigation artifact from the previous step:

```bash
# Check for artifact in workflow runs directory
ls $ARTIFACTS_DIR/investigation.md
```

**If input is a specific path**, use that path directly.

### 1.2 Load and Parse Artifact

```bash
cat {artifact-path}
```

**Extract from artifact:**
- Issue number and title
- Type (BUG/ENHANCEMENT/etc)
- Files to modify (with line numbers)
- Implementation steps
- Validation commands
- Test cases to add

### 1.3 Validate Artifact Exists

**If artifact not found:**
```
❌ Investigation artifact not found at $ARTIFACTS_DIR/investigation.md

Run `/investigate-issue {number}` first to create the implementation plan.
```

**PHASE_1_CHECKPOINT:**
- [ ] Artifact found and loaded
- [ ] Key sections parsed (files, steps, validation)
- [ ] Issue number extracted (if applicable)

---

## Phase 2: VALIDATE - Sanity Check

### 2.1 Verify Plan Accuracy

For each file mentioned in the artifact:
- Read the actual current code
- Compare to what artifact expects
- Check if the "current code" snippets match reality

**If significant drift detected:**
```
⚠️ Code has changed since investigation:

File: src/x.ts:45
- Artifact expected: {snippet}
- Actual code: {different snippet}

Options:
1. Re-run /investigate-issue to get fresh analysis
2. Proceed carefully with manual adjustments
```

### 2.2 Confirm Approach Makes Sense

Ask yourself:
- Does the proposed fix actually address the root cause?
- Are there obvious problems with the approach?
- Has something changed that invalidates the plan?

**If plan seems wrong:**
- STOP
- Explain what's wrong
- Suggest re-investigation

**PHASE_2_CHECKPOINT:**
- [ ] Artifact matches current codebase state
- [ ] Approach still makes sense
- [ ] No blocking issues identified

---

## Phase 3: GIT-CHECK - Ensure Correct State

### 3.1 Check Current Git State

```bash
# What branch are we on?
git branch --show-current

# Are we in a worktree?
git rev-parse --show-toplevel
git worktree list

# Is working directory clean?
git status --porcelain

# Are we up to date with remote?
git fetch origin
git status
```

### 3.2 Decision Tree

```
┌─ IN WORKTREE?
│  └─ YES → Use it (assume it's for this work)
│           Log: "Using worktree at {path}"
│
├─ ON MAIN/MASTER?
│  └─ Q: Working directory clean?
│     ├─ YES → Create branch: fix/issue-{number}-{slug}
│     │        git checkout -b fix/issue-{number}-{slug}
│     └─ NO  → Warn user:
│              "Working directory has uncommitted changes.
│               Please commit or stash before proceeding."
│              STOP
│
├─ ON FEATURE/FIX BRANCH?
│  └─ Use it (assume it's for this work)
│     If branch name doesn't contain issue number:
│       Warn: "Branch '{name}' may not be for issue #{number}"
│
└─ DIRTY STATE?
   └─ Warn and suggest: git stash or git commit
      STOP
```

### 3.3 Ensure Up-to-Date

```bash
# If branch tracks remote
git pull --rebase origin $BASE_BRANCH 2>/dev/null || git pull origin $BASE_BRANCH
```

**PHASE_3_CHECKPOINT:**
- [ ] Git state is clean and correct
- [ ] On appropriate branch (created or existing)
- [ ] Up to date with base branch

---

## Phase 4: DEPENDENCIES - Discover and Install

### 4.1 Detect Install Command

Inspect the worktree for lock/config files and choose the install command:

- `package.json` + `bun.lock` → `bun install`
- `package.json` + `package-lock.json` → `npm install`
- `package.json` + `yarn.lock` → `yarn install`
- `package.json` + `pnpm-lock.yaml` → `pnpm install`
- `requirements.txt` → `pip install -r requirements.txt`
- `pyproject.toml` + `poetry.lock` → `poetry install`
- `Cargo.toml` → `cargo build`
- `go.mod` → `go mod download`

### 4.2 Run Install

Run the chosen install command from the worktree root before any validation or tests.

### 4.3 Failure Handling

If install fails, STOP and report the error. Do not proceed to validation with missing dependencies.

**PHASE_4_CHECKPOINT:**
- [ ] Install command discovered
- [ ] Dependencies installed successfully

---

## Phase 5: IMPLEMENT - Make Changes

### 5.1 Execute Each Step

For each step in the artifact's Implementation Plan:

1. **Read the target file** - understand current state
2. **Make the change** - exactly as specified
3. **Verify types compile** - `bun run type-check`

### 5.2 Implementation Rules

**DO:**
- Follow artifact steps in order
- Match existing code style exactly
- Copy patterns from "Patterns to Follow" section
- Add tests as specified

**DON'T:**
- Refactor unrelated code
- Add "improvements" not in the plan
- Change formatting of untouched lines
- Deviate from the artifact without noting it

### 5.3 Handle Each File Type

**For UPDATE files:**
- Read current content
- Find the exact lines mentioned
- Make the specified change
- Preserve surrounding code

**For CREATE files:**
- Use patterns from artifact
- Follow existing file structure conventions
- Include all specified content

**For test files:**
- Add test cases as specified
- Follow existing test patterns
- Ensure tests actually test the fix

### 5.4 Track Deviations

If you must deviate from the artifact:
- Note what changed and why
- Include in PR description

**PHASE_5_CHECKPOINT:**
- [ ] All steps from artifact executed
- [ ] Types compile after each change
- [ ] Tests added as specified
- [ ] Any deviations documented

---

## Phase 6: VERIFY - Run Validation

### 6.1 Run Artifact Validation Commands

Execute each command from the artifact's Validation section:

```bash
bun run type-check
bun test {pattern-from-artifact}
bun run lint
```

### 6.2 Check Results

**All must pass before proceeding.**

If failures:
1. Analyze what's wrong
2. Fix the issue
3. Re-run validation
4. Note any fixes in PR description

### 6.3 Manual Verification (if specified)

Execute any manual verification steps from the artifact.

**PHASE_6_CHECKPOINT:**
- [ ] Type check passes
- [ ] Tests pass
- [ ] Lint passes
- [ ] Manual verification complete (if applicable)

---

## Phase 7: COMMIT - Save Changes

### 7.1 Stage Changes

```bash
git add -A
git status  # Review what's being committed
```

### 7.2 Write Commit Message

**Format:**
```
Fix: {brief description} (#{issue-number})

{Problem statement from artifact - 1-2 sentences}

Changes:
- {Change 1 from artifact}
- {Change 2 from artifact}
- Added test for {case}

Fixes #{issue-number}
```

**Commit:**
```bash
git commit -m "$(cat <<'EOF'
Fix: {title} (#{number})

{problem statement}

Changes:
- {change 1}
- {change 2}

Fixes #{number}
EOF
)"
```

**PHASE_7_CHECKPOINT:**
- [ ] All changes committed
- [ ] Commit message references issue

---

## Phase 8: PR - Create Pull Request

**Before creating a PR**, check if one already exists for this issue or branch using `gh pr list`. If a PR already exists, skip creation and use the existing one.

### 8.1 Push to Remote

```bash
git push -u origin HEAD
```

If branch was rebased:
```bash
git push -u origin HEAD --force-with-lease
```

### 8.2 Prepare PR Body

Look for the project's PR template at `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, or `docs/PULL_REQUEST_TEMPLATE.md`. Read whichever one exists.

**If template found**: Use it as the structure, fill in **every section** with details from the artifact (root cause, changes, validation results, etc.). Don't skip sections or leave placeholders. Make sure to include `Fixes #{number}`.

**If no template**, write a body covering: summary, root cause, changes table, validation evidence, and `Fixes #{number}`.

### 8.3 Create PR

Write the prepared body to `$ARTIFACTS_DIR/pr-body.md`, then:

```bash
gh pr create --title "Fix: {title} (#{number})" \
  --body-file $ARTIFACTS_DIR/pr-body.md
```

### 8.3 Get PR Number

```bash
PR_URL=$(gh pr view --json url -q '.url')
PR_NUMBER=$(gh pr view --json number -q '.number')
```

**PHASE_8_CHECKPOINT:**
- [ ] Changes pushed to remote
- [ ] PR created
- [ ] PR linked to issue with "Fixes #{number}"

---

## Phase 9: WRITE - Implementation Report

### 9.1 Write Implementation Artifact

Write to `$ARTIFACTS_DIR/implementation.md`:

```markdown
# Implementation Report

**Issue**: #{number}
**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID

---

## Tasks Completed

| # | Task | File | Status |
|---|------|------|--------|
| 1 | {task} | `src/x.ts` | ✅ |
| 2 | {task} | `src/x.test.ts` | ✅ |

---

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `src/x.ts` | UPDATE | +{N}/-{M} |
| `src/x.test.ts` | CREATE | +{N} |

---

## Deviations from Investigation

{If none: "Implementation matched the investigation exactly."}

{If any:}
### Deviation 1: {title}

**Expected**: {from investigation}
**Actual**: {what was done}
**Reason**: {why}

---

## Validation Results

| Check | Result |
|-------|--------|
| Type check | ✅ |
| Tests | ✅ ({N} passed) |
| Lint | ✅ |

---

## PR Created

- **Number**: #{pr-number}
- **URL**: {pr-url}
- **Branch**: {branch-name}
```

**PHASE_9_CHECKPOINT:**
- [ ] Implementation artifact written

---

## Phase 10: OUTPUT - Report to User

Skip archiving - artifacts remain in place for review workflow to access.

---

```markdown
## Implementation Complete

**Issue**: #{number} - {title}
**Branch**: `{branch-name}`
**PR**: #{pr-number} - {pr-url}

### Changes Made

| File | Change |
|------|--------|
| `src/x.ts` | {description} |
| `src/x.test.ts` | Added test |

### Validation

| Check | Result |
|-------|--------|
| Type check | ✅ Pass |
| Tests | ✅ Pass |
| Lint | ✅ Pass |

### Artifacts

- 📄 Investigation: `$ARTIFACTS_DIR/investigation.md`
- 📄 Implementation: `$ARTIFACTS_DIR/implementation.md`

### Next Step

Proceeding to comprehensive code review...
```

---

## Handling Edge Cases

### Artifact is outdated
- Warn user about drift
- Suggest re-running `/investigate-issue`
- Can proceed with caution if changes are minor

### Tests fail after implementation
- Debug the failure
- Fix the code (not the test, unless test is wrong)
- Re-run validation
- Note the additional fix in PR

### Merge conflicts during rebase
- Resolve conflicts
- Re-run full validation
- Note conflict resolution in PR

### PR creation fails
- Check if PR already exists for branch
- Check for permission issues
- Provide manual gh command

### Already on a branch with changes
- Use the existing branch
- Warn if branch name doesn't match issue
- Don't create a new branch

### In a worktree
- Use it as-is
- Assume it was created for this purpose
- Log that worktree is being used

---

## Success Criteria

- **PLAN_EXECUTED**: All investigation steps completed
- **VALIDATION_PASSED**: All checks green
- **PR_CREATED**: PR exists and linked to issue
- **IMPLEMENTATION_ARTIFACT**: Written to runs/$WORKFLOW_ID/
- **READY_FOR_REVIEW**: Workflow continues to comprehensive review
