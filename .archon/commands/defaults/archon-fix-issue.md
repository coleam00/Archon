---
description: Implement a fix from investigation artifact - code changes, validation, and commit (no PR)
argument-hint: <issue-number|artifact-path>
---

# Fix Issue

**Input**: $ARGUMENTS

---

## READ FIRST: you are almost certainly in a run worktree

When this command runs inside an Archon workflow, the isolation system has **already**
created a git worktree on the correct branch. In that case:

- **Use the current branch as-is.** Do not switch branches, do not create one, do not
  fetch-and-reset. The branch you are on is the branch this work belongs to.
- **A dirty working tree is expected and is NOT a reason to stop.** Archon copies the
  operator's `.archon/` directory — workflows, commands, scripts — into every run
  worktree, deliberately, so a workflow can be iterated on before it is committed.
  Those files are present *before* you start and are not your changes.
- **Pre-existing modifications under `.archon/` are never yours to commit, stash, or
  remove.** Leave them exactly as they are and commit only the files your implementation
  touched. Before every commit, confirm with `git diff --cached --name-only` that no
  `.archon/` file you did not deliberately change is staged.
- **The exception: when the issue's fix genuinely lives under `.archon/`.** Workflows,
  commands and scripts are source too, and an issue can legitimately target one. If your
  plan says to edit a specific `.archon/` file, edit and commit **that file** — the rule
  above exists to stop you sweeping up the operator's unrelated copied-in edits, not to
  make a whole directory unfixable.

  Distinguish the two by intent, not by path: a file your plan names is your work; every
  other dirty `.archon/` file is not. On 2026-08-03 a run blocked outright on this,
  correctly reporting "contradictory instructions" because the issue required editing a
  workflow YAML while this section forbade touching anything under `.archon/`. It was
  right to refuse rather than guess — and the rule was wrong to be absolute.

  **A named file is not a blank cheque for that file.** It may already carry copied-in
  edits from before you started, and staging it whole would commit those too — the
  path-level check above cannot see inside a file. So before you touch a planned
  `.archon/` file, record its baseline:

  ```bash
  # HEAD, not the index: `git diff -- <file>` compares the worktree against the
  # INDEX, so pre-existing changes that are already STAGED do not appear — and
  # `git add -p` will neither show nor remove them, so they ride into your commit
  # invisibly. Diffing against HEAD captures staged and unstaged alike.
  git diff HEAD -- <the-planned-file> > /tmp/archon-baseline.diff   # empty if clean
  ```

  Then, before staging anything of your own, clear that file out of the index so the
  only thing you can stage is what you deliberately pick:

  ```bash
  git restore --staged <the-planned-file>   # no-op if nothing was staged
  git add -p <the-planned-file>             # stage ONLY your own hunks
  ```

  Reject any hunk that also appears in the baseline. If yours and theirs are entangled
  such that you cannot separate them, stop and say so rather than committing someone
  else's work under your change. That is the same call the 2026-08-03 run made, and it
  was the right one.
- **Dirty paths outside `.archon/` are also not a reason to stop, and also not yours.**
  They are either your own work from an earlier attempt at this run (resume reuses the
  worktree) or something the operator left behind. Either way: leave them alone, do not
  fold them into your commit, and stage your own files by name rather than with
  `git add -A`.

The clean-working-tree requirement in the decision tree below applies **only** to the
`ON $BASE_BRANCH` case — manual CLI use outside a worktree, where a stray edit really
could be lost. It does not apply in a worktree. If a skill or sub-workflow you load
imposes a stricter git precondition, **this instruction overrides it.**

Classify the checkout before deciding anything. `git worktree list` does **not** answer
this — it lists every worktree including the primary checkout, so it looks identical
from both. Compare the two git dirs instead:

```bash
if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
  echo "linked worktree — the rules above apply"
else
  echo "primary checkout — follow the decision tree below as written"
fi
```

Stopping a run over pre-existing `.archon/` edits wastes the entire pipeline; it has
happened, three times. Applying the worktree exemption in the *primary* checkout is the
opposite error and can lose someone's uncommitted work. Classify first, then decide.

---

## Your Mission

Execute the implementation plan from `/investigate-issue`:

1. Load and validate the artifact
2. Ensure git state is correct
3. Discover and install dependencies in the worktree
4. Implement the changes exactly as specified
5. Run validation
6. Commit changes
7. Write implementation report

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

```text
┌─ IN WORKTREE?
│  └─ YES → Use current branch AS-IS. Do NOT switch branches. Do NOT create
│           new branches. The isolation system has already set up the correct
│           branch; any deviation operates on the wrong code.
│           Log: "Using worktree at {path} on branch {branch}"
│
├─ ON $BASE_BRANCH? (main, master, or configured base branch)
│  └─ Q: Working directory clean?
│     ├─ YES → Create branch: fix/issue-{number}-{slug}
│     │        git checkout -b fix/issue-{number}-{slug}
│     │        (only applies outside a worktree — e.g., manual CLI usage)
│     └─ NO  → STOP: "Uncommitted changes on $BASE_BRANCH.
│              Please commit or stash before proceeding."
│
├─ ON OTHER BRANCH?
│  └─ Use it AS-IS (assume it was set up for this work).
│     Do NOT switch to another branch (e.g., one shown by `git branch` but
│     not currently checked out).
│     If branch name doesn't contain issue number:
│       Warn: "Branch '{name}' may not be for issue #{number}"
│
└─ DIRTY STATE?
   └─ STOP: "Uncommitted changes. Please commit or stash first."
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
- Include in implementation report

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
4. Note any fixes in implementation report

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

Stage **only** the files you actually edited — never `git add -A`, `git add .`, or `git add -u`. List them by name:

```bash
git add path/to/file1 path/to/file2 ...
git status --porcelain  # verify nothing scratch/review/PR-body is staged
```

**Never stage**:

- `.pr-body.md`, `pr-body.md`, `*.scratch.md`, `*.tmp.md`
- `review/`, `*-report.md` at the repo root
- Anything under `$ARTIFACTS_DIR`
- Repo-local Archon telemetry: `.archon/artifacts/`, `.archon/logs/`, `.archon/state/` (local-only — never in git)

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

## Phase 8: WRITE - Implementation Report

### 8.1 Write Implementation Artifact

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
```

**PHASE_8_CHECKPOINT:**
- [ ] Implementation artifact written

---

## Phase 9: OUTPUT - Report to User

Skip archiving - artifacts remain in place for review workflow to access.

---

```markdown
## Implementation Complete

**Issue**: #{number} - {title}
**Branch**: `{branch-name}`

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

Proceeding to PR creation...
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
- Note the additional fix in implementation report

### Merge conflicts during rebase
- Resolve conflicts
- Re-run full validation
- Note conflict resolution in implementation report

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
- **CHANGES_COMMITTED**: All changes committed to branch
- **IMPLEMENTATION_ARTIFACT**: Written to $ARTIFACTS_DIR/
- **READY_FOR_PR**: Workflow continues to PR creation
