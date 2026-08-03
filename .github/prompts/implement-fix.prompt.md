---
description: "Implement a fix from investigation artifact - code changes, PR, and self-review"
argument-hint: "<issue-number | path/to/artifact.md>"
agent: "agent"
tools:
  - codebase
  - editFiles
  - createFile
  - createDirectory
  - readFile
  - runInTerminal
  - problems
  - runTests
  - textSearch
  - fileSearch
  - usages
---

# Implement Issue Fix

**Input**: ${input:issue:Issue number or path to investigation artifact}

## Your Mission

Execute the implementation plan from `/investigate-debug`:

1. Load and validate the artifact
2. Ensure git state is correct
3. Implement the changes exactly as specified
4. Run validation
5. Create PR linked to issue
6. Self-review and post findings
7. Archive the artifact

**Golden Rule**: Follow the artifact. If something seems wrong, validate it first - don't silently deviate.

---

## Phase 1: DETECT - Find the Artifact and Base Branch

### 1.1 Detect Base Branch

Determine the base branch for branching, syncing, and PR creation:

```bash
# Try auto-detect from remote
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
```

If that fails:

```bash
git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}'
```

**Last resort**: `main`

Store as `{base-branch}` — use this for ALL branch operations. Never hardcode `main` or `master`.

### 1.2 Find the Artifact

**If input looks like a number** (`123`, `#123`):

```bash
ls .agents/investigations/issue-{number}.md
```

**If input is a path**: Use the path directly.

### 1.3 Load and Parse Artifact

Read the artifact and extract:

- Issue number and title
- Type (BUG/ENHANCEMENT/etc)
- Files to modify (with line numbers)
- Implementation steps
- Patterns to follow
- Validation commands
- Test cases to add

**If artifact not found:**

```
Error: Artifact not found at .agents/investigations/issue-{number}.md

Run `/investigate-debug {number}` first to create the implementation plan.
```

---

## Phase 2: VALIDATE - Sanity Check

### 2.1 Verify Plan Accuracy

For each file mentioned in the artifact:

- Read the actual current code
- Compare to what artifact expects ("Current code" snippets)
- Check if the code has changed since investigation

**If significant drift detected:**

```
Warning: Code has changed since investigation:

File: src/x.ts:45
- Artifact expected: {snippet}
- Actual code: {different snippet}

Options:
1. Re-run /investigate-debug to get fresh analysis
2. Proceed carefully with manual adjustments
```

### 2.2 Confirm Approach

- Does the proposed fix address the root cause?
- Are there obvious problems with the approach?
- Has something changed that invalidates the plan?

**If plan seems wrong**: STOP and explain what's wrong. Suggest re-investigation.

---

## Phase 3: GIT-CHECK - Ensure Correct State

### 3.1 Check Current Git State

```bash
git branch --show-current
git status --porcelain
git fetch origin
```

### 3.2 Decision Tree

| State | Action |
|-------|--------|
| On {base-branch}, clean | Create branch: `git checkout -b fix/issue-{number}-{slug}` |
| On {base-branch}, dirty | STOP: "Stash or commit changes first" |
| On feature/fix branch | Use it (warn if branch name doesn't match issue) |

### 3.3 Sync with Base

```bash
git pull --rebase origin {base-branch} 2>/dev/null || git pull origin {base-branch}
```

---

## Phase 4: IMPLEMENT - Make Changes

### 4.1 Execute Each Step

For each step in the artifact's Implementation Plan:

1. **Read the target file** — understand current state
2. **Read the MIRROR reference** — understand the pattern to follow
3. **Make the change** — exactly as specified
4. **Run type check** — verify types compile

```bash
# After EVERY file change (adapt to project toolchain)
pnpm run build  # or: npx tsc --noEmit, mypy ., cargo check, go build ./...
```

**If it fails:**

1. Read the error
2. Fix the issue
3. Re-run validation
4. Only proceed when passing

### 4.2 Implementation Rules

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

### 4.3 Handle Each File Type

**For UPDATE files:**

- Read current content
- Find the exact lines mentioned
- Make the specified change
- Preserve surrounding code

**For CREATE files:**

- Use patterns from artifact
- Follow existing file structure conventions
- Include all specified content

### 4.4 Track Progress

```
Step 1: UPDATE src/x.ts ✅
Step 2: CREATE src/x.test.ts ✅
```

**If you deviate from the artifact**, document what changed and why.

---

## Phase 5: VERIFY - Run Validation

### 5.1 Run Validation Commands

Execute each command from the artifact's Validation section:

```bash
# Adapt to project's toolchain
pnpm run build          # Type check
pnpm test               # Tests
pnpm run lint           # Lint
```

### 5.2 All Must Pass

**If failures:**

1. Analyze what's wrong
2. Fix the issue (the code, not the test — unless the test is wrong)
3. Re-run validation
4. Note any additional fixes

### 5.3 Manual Verification

Execute any manual verification steps from the artifact.

---

## Phase 6: COMMIT - Save Changes

### 6.1 Stage Changes

```bash
# Stage specific files (prefer over git add -A)
git add {list of changed files}
git status
```

### 6.2 Commit

**Format:**

```
{type}: {brief description} (#{issue-number})

{Problem statement from artifact - 1-2 sentences}

Changes:
- {Change 1}
- {Change 2}
- Added test for {case}

Fixes #{issue-number}
```

Where `{type}` is:

| Issue Type | Prefix |
|------------|--------|
| BUG | `fix` |
| ENHANCEMENT | `feat` |
| REFACTOR | `refactor` |
| CHORE | `chore` |
| DOCUMENTATION | `docs` |

---

## Phase 7: PR - Create Pull Request

### 7.1 Push

```bash
git push -u origin HEAD
```

### 7.2 Create PR

````bash
gh pr create --base "{base-branch}" --title "{type}: {title} (#{number})" --body "$(cat <<'EOF'
## Summary

{Problem statement from artifact}

## Root Cause

{Root cause summary from artifact}

## Changes

| File | Change |
|------|--------|
| `src/x.ts` | {description} |
| `src/x.test.ts` | Added test for {case} |

## Testing

- [x] Type check passes
- [x] Tests pass
- [x] Lint passes
- [x] {Manual verification from artifact}

## Validation

```bash
pnpm run build && pnpm test && pnpm run lint
````

## Issue

Fixes #{number}

<details>
<summary>Implementation Details</summary>

**Artifact**: `.agents/investigations/issue-{number}.md`

**Deviations from plan**: {None | List any deviations}

</details>
EOF
)"
````

### 7.3 Capture PR Info

```bash
gh pr view --json url,number
```

---

## Phase 8: REVIEW - Self Code Review

### 8.1 Review the Diff

```bash
gh pr diff
```

Check:

1. Does the fix address the root cause from the investigation?
2. Does the code match codebase patterns?
3. Are the new tests sufficient?
4. Are edge cases handled?
5. Any security concerns?
6. Anything that could break?

### 8.2 Post Review to PR

```bash
gh pr comment --body "$(cat <<'EOF'
## Self-Review

### Summary

{1-2 sentence assessment}

### Strengths

- {Good thing 1}
- {Good thing 2}

### Suggestions (non-blocking)

- `{file}:{line}` - {suggestion}

### Checklist

- [x] Fix addresses root cause from investigation
- [x] Code follows codebase patterns
- [x] Tests cover the change
- [x] No obvious bugs introduced
- [x] No security concerns

*Ready for human review*
EOF
)"
```

---

## Phase 9: ARCHIVE - Clean Up

### 9.1 Move Artifact to Completed

```bash
mkdir -p .agents/investigations/completed
mv .agents/investigations/issue-{number}.md .agents/investigations/completed/
```

### 9.2 Commit and Push Archive

```bash
git add .agents/investigations/
git commit -m "Archive investigation for issue #{number}"
git push
```

---

## Phase 10: OUTPUT - Report to User

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
| Type check | Pass |
| Tests | Pass |
| Lint | Pass |

### Self-Review

{Summary of review findings}

### Artifact

Archived to `.agents/investigations/completed/issue-{number}.md`

### Next Steps

- Human review of PR #{pr-number}
- Merge when approved
```

---

## Handling Edge Cases

| Scenario | Action |
|----------|--------|
| Artifact is outdated (code drift) | Warn user, suggest re-running `/investigate-debug` |
| Tests fail after implementation | Debug, fix the code (not the test), re-run validation |
| Merge conflicts during rebase | Resolve conflicts, re-run full validation |
| PR creation fails | Check if PR already exists, provide manual `gh` command |
| Already on a branch with changes | Use existing branch, warn if name doesn't match issue |
| No issue number (free-form investigation) | Skip "Fixes #" in commit/PR, no GitHub linking |

---

## Success Criteria

- **PLAN_EXECUTED**: All artifact steps completed
- **VALIDATION_PASSED**: All checks green
- **PR_CREATED**: PR exists and linked to issue
- **REVIEW_POSTED**: Self-review comment on PR
- **ARTIFACT_ARCHIVED**: Moved to completed folder
