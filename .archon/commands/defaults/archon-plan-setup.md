---
description: plan 실행 준비 — plan 읽기, branch 준비 확인, context artifact 작성
argument-hint: <path/to/plan.md>
---

# Plan 설정

**Plan**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## 미션

Prepare everything needed for plan implementation:
1. Read and parse the plan (including scope limits)
2. Ensure we're on the correct branch
3. Write a comprehensive context artifact for subsequent steps

**This step does NOT implement anything** - it only sets up the environment.
**This step does NOT create a PR** - that happens in `archon-finalize-pr` after implementation.

---

## 1단계: 로드 — plan 읽기

### 1.1 plan file 찾기

**Check in order:**

1. **If `$ARGUMENTS` provided**: Use that path
2. **If plan already in workflow artifacts**: Use `$ARTIFACTS_DIR/plan.md`

```bash
# Check if plan was created by archon-create-plan in this workflow
if [ -f "$ARTIFACTS_DIR/plan.md" ]; then
  PLAN_PATH="$ARTIFACTS_DIR/plan.md"
  echo "Using plan from workflow: $PLAN_PATH"
elif [ -n "$ARGUMENTS" ] && [ -f "$ARGUMENTS" ]; then
  PLAN_PATH="$ARGUMENTS"
  echo "Using plan from arguments: $PLAN_PATH"
else
  echo "ERROR: No plan found"
  exit 1
fi
```

### 1.2 plan file 로드

Read the plan file:

```bash
cat $PLAN_PATH
```

If `$ARGUMENTS` is a GitHub issue URL or number (e.g., `#123`), fetch the issue body instead.

### 1.3 핵심 정보 추출

From the plan, identify and extract:

| Field | Where to Find | Example |
|-------|---------------|---------|
| **Title** | First `#` heading or "Summary" section | "Discord Platform Adapter" |
| **Summary** | "Summary" or "Feature Description" section | 1-2 sentence overview |
| **Files to Change** | "Files to Change" or "Tasks" section | List of CREATE/UPDATE files |
| **Validation Commands** | "Validation Commands" or "Validation Strategy" | `bun run type-check`, etc. |
| **Acceptance Criteria** | "Acceptance Criteria" section | Checklist items |
| **NOT Building (Scope Limits)** | "NOT Building", "Scope Limits", or "Out of Scope" section | Explicit exclusions |

**CRITICAL**: The "NOT Building" section defines what is **intentionally excluded** from scope. This MUST be captured and passed to review agents so they don't flag intentional exclusions as bugs.

### 1.4 branch name 도출

Create a branch name from the plan title:

```
feature/{slug}
```

Where `{slug}` is the title lowercased, spaces replaced with hyphens, max 50 chars.

Examples:
- "Discord Platform Adapter" → `feature/discord-platform-adapter`
- "ESLint/Prettier Integration" → `feature/eslint-prettier-integration`

**PHASE_1_CHECKPOINT:**

- [ ] Plan file loaded and readable
- [ ] Key information extracted
- [ ] Branch name derived

---

## 2단계: 준비 — git 상태

### 2.1 확인 현재 상태

```bash
git branch --show-current
git status --porcelain
git remote get-url origin
```

### 2.2 repository 정보 결정

Extract owner/repo from the remote URL for PR creation:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

### 2.3 branch 결정

Evaluate in order (first matching case wins):

```text
┌─ IN WORKTREE?
│  └─ YES → Use current branch AS-IS. Do NOT switch branches. Do NOT create
│           new branches. The isolation system has already set up the correct
│           branch; any deviation operates on the wrong code.
│           Log: "Using worktree branch: {name}"
│
├─ ON $BASE_BRANCH? (main, master, or configured base branch)
│  └─ Q: Working directory clean?
│     ├─ YES → Create and checkout: `git checkout -b {branch-name}`
│     │        (only applies outside a worktree — e.g., manual CLI usage)
│     └─ NO  → STOP: "Uncommitted changes on $BASE_BRANCH. Stash or commit first."
│
└─ ON OTHER BRANCH?
   └─ Q: Does it match the expected branch for this plan?
      ├─ YES → Use it, log "Using existing branch: {name}"
      └─ NO  → STOP: "On branch {X}, expected {Y}. Switch branches or adjust plan."
```

### 2.4 remote와 sync

```bash
git fetch origin
git rebase origin/$BASE_BRANCH || git merge origin/$BASE_BRANCH
```

If conflicts occur, STOP with error: "Merge conflicts with $BASE_BRANCH. Resolve manually."

### 2.5 commit이 있으면 branch push

If there are commits on the branch:
```bash
git push -u origin HEAD
```

If no commits yet (fresh branch), skip push - it will happen after implementation.

**PHASE_2_CHECKPOINT:**

- [ ] On correct branch
- [ ] No uncommitted changes
- [ ] Up to date with base branch

---

## 3단계: Artifact — context file 작성

### 3.1 artifact directory 생성

```bash
```

### 3.2 context artifact 작성

Write to `$ARTIFACTS_DIR/plan-context.md`:

```markdown
# Plan Context

**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID
**Plan Source**: $ARGUMENTS

---

## Branch

| Field | Value |
|-------|-------|
| **Branch** | {branch-name} |
| **Base** | {base-branch} |

---

## Plan Summary

**Title**: {extracted-title}

**Overview**: {1-2 sentence summary from plan}

---

## Files to Change

{Copy the "Files to Change" table from the plan, or list extracted files}

| File | Action |
|------|--------|
| `src/example.ts` | CREATE |
| `src/other.ts` | UPDATE |

---

## NOT Building (Scope Limits)

**CRITICAL FOR REVIEWERS**: These items are **intentionally excluded** from scope. Do NOT flag them as bugs or missing features.

{Copy from plan's "NOT Building", "Scope Limits", or "Out of Scope" section}

- {Explicit exclusion 1 with rationale}
- {Explicit exclusion 2 with rationale}

{If no explicit exclusions in plan: "No explicit scope limits defined in plan."}

---

## Validation Commands

{Copy from plan's "Validation Commands" section}

```bash
bun run type-check
bun run lint
bun test
bun run build
```

---

## Acceptance Criteria

{Copy from plan's "Acceptance Criteria" section}

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] ...

---

## Patterns to Mirror

{Copy key file references from plan's "Patterns to Mirror" section}

| Pattern | Source File | Lines |
|---------|-------------|-------|
| {pattern-name} | `src/example.ts` | 10-50 |

---

## Next Steps

1. `archon-confirm-plan` - Verify patterns still exist
2. `archon-implement-tasks` - Execute the plan
3. `archon-validate` - Run full validation
4. `archon-finalize-pr` - Create PR and mark ready
```

**PHASE_3_CHECKPOINT:**

- [ ] Artifact directory created
- [ ] `plan-context.md` written with all sections
- [ ] "NOT Building" section captured (even if empty)

---

## 4단계: 출력 — 사용자에게 보고

```markdown
## Plan Setup Complete

**Plan**: `$ARGUMENTS`
**Workflow ID**: `$WORKFLOW_ID`

### Branch

| Field | Value |
|-------|-------|
| Branch | `{branch-name}` |
| Base | `{base-branch}` |

### Plan Summary

**{plan-title}**

{1-2 sentence overview}

### Scope

- {N} files to create
- {M} files to update
- {K} explicit exclusions captured

### Artifact

Context written to: `$ARTIFACTS_DIR/plan-context.md`

### Next Step

Proceed to `archon-confirm-plan` to verify the plan's research is still valid.
```

---

## 오류 처리

### Plan 파일 없음

```
❌ Plan not found: $ARGUMENTS

Verify the path exists and try again.
```

### Base branch에 commit되지 않은 변경사항 있음

```
❌ Uncommitted changes on base branch

Options:
1. Stash changes: `git stash`
2. Commit changes: `git add . && git commit -m "WIP"`
3. Discard changes: `git checkout .`

Then retry.
```

### Merge conflict

```
❌ Merge conflicts with $BASE_BRANCH

Resolve conflicts manually:
1. `git status` to see conflicts
2. Edit conflicting files
3. `git add <resolved-files>`
4. `git rebase --continue`

Then retry.
```

---

## 성공 기준

- **PLAN_LOADED**: Plan file read and parsed
- **SCOPE_LIMITS_CAPTURED**: "NOT Building" section extracted (even if empty)
- **BRANCH_READY**: On correct branch, synced with base branch
- **ARTIFACT_WRITTEN**: `plan-context.md` contains all required sections including scope limits
