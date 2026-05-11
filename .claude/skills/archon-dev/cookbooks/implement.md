# Implement Cookbook

Execute a plan file step by step with validation gates. No auto-retry — failures are surfaced to the user.

**Input**: `$ARGUMENTS` — path to a `.plan.md` file, or omit to auto-detect the latest plan. Optional: `--base <branch>` to override base branch.

---

## Phase 0: DETECT — Project Environment

### 0.1 Identify Package Manager

| File Found | Package Manager | Runner |
|------------|-----------------|--------|
| `bun.lockb` | bun | `bun` / `bun run` |
| `pnpm-lock.yaml` | pnpm | `pnpm` / `pnpm run` |
| `yarn.lock` | yarn | `yarn` / `yarn run` |
| `package-lock.json` | npm | `npm run` |

**Store the detected runner** — use it for all subsequent commands.

### 0.2 Detect Base Branch

1. **Check arguments**: If `$ARGUMENTS` contains `--base <branch>`, extract that value
2. **Auto-detect from remote**:
   ```bash
   git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
   ```
3. **Fallback**:
   ```bash
   git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}'
   ```
4. **Last resort**: `main`

**Store as `{base-branch}`** — use for ALL branch comparisons. Never hardcode `main` or `master`.

### 0.3 Identify Validation Scripts

Check `package.json` for available scripts: `type-check`, `lint`, `lint:fix`, `test`, `build`, `validate`.

**Use the plan's "Validation Commands" section** — it specifies exact commands for this project.

**CHECKPOINT**: Runner detected. Base branch determined. Validation scripts identified.

---

## Phase 1: LOAD — Read the Plan

1. **If path provided**: Read the plan file at `$ARGUMENTS`
2. **If no path**: Look for the most recent `.plan.md` in `.claude/archon/plans/` (excluding `completed/`)
3. **If no plans found**: Tell the user and suggest `/archon-dev plan`

Parse the plan and extract:
- **Mandatory Reading** list
- **Step-by-Step Tasks** list
- **Validation Commands**
- **Acceptance Criteria**

**CHECKPOINT**: Plan loaded and understood.

---

## Phase 2: PREFLIGHT — Verify Readiness

### 2.1 Read Mandatory Reading

Read every P0 and P1 file listed in the plan. Verify that "Patterns to Mirror" code snippets are still accurate.

If patterns have drifted from what the plan describes, note the discrepancy and adapt. Do NOT blindly follow stale patterns.

### 2.2 Check Git State

```bash
git branch --show-current
git status --porcelain
git worktree list
```

| Current State | Action |
|---------------|--------|
| In worktree | Use it (log: "Using worktree") |
| On {base-branch}, clean | Create branch: `git checkout -b feature/{plan-slug}` |
| On {base-branch}, dirty | STOP: "Stash or commit changes first" |
| On feature branch, clean | Use it (log: "Using existing branch") |
| On feature branch, dirty | STOP: "Commit or stash current changes first" |

### 2.3 Sync with Remote

```bash
git fetch origin
git pull --rebase origin {base-branch} 2>/dev/null || true
```

**CHECKPOINT**: All mandatory reading complete. Patterns verified. Branch is clean and synced.

---

## Phase 3: EXECUTE — Work Through Tasks

For each task in the plan, sequentially:

1. **Read the target file(s)** before making changes
2. **Read the MIRROR reference** from the task and actually mirror it
3. **Make the changes** described in the task
4. **Run incremental validation** — at minimum, type-check after each task
5. **If validation fails**: Fix immediately before moving to the next task
6. **If stuck after 2 fix attempts**: Stop and present the issue to the user — do NOT guess

**Rules:**
- Follow the plan's task order (dependencies matter)
- If a task is unclear, re-read the plan context rather than improvising
- Track which tasks are complete as you go

**Deviation Handling:** If you must deviate from the plan:
- Note WHAT changed
- Note WHY it changed
- Continue with the deviation documented

---

## Phase 4: VALIDATE — Full Validation Gate

After ALL tasks are complete, run the full validation suite from the plan:

1. **Level 1**: Type check
2. **Level 2**: Lint (run lint:fix first if available, then lint)
3. **Level 3**: Unit tests
4. **Level 4**: Full validation (if available, e.g., `bun run validate`)
5. **Level 5**: Database validation (if schema changes)
6. **Level 6**: Manual verification (if specified in plan)

**If failures exist**: Fix them and re-run the failing validation level. Repeat until all pass.

**Do NOT auto-loop indefinitely.** If the same failure persists after 2 fix attempts, stop and ask the user.

---

## Phase 5: REPORT — Write Implementation Report

Save to `.claude/archon/reports/{slug}-report.md` using the plan's slug.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Implementation Report

**Plan**: `{path to plan file}`
**Branch**: {current branch}
**Date**: {YYYY-MM-DD}
**Status**: COMPLETE / PARTIAL

---

## Summary

{What was done — 2-3 sentences}

## Assessment vs Reality

| Metric | Predicted | Actual | Reasoning |
|--------|-----------|--------|-----------|
| Complexity | {from plan} | {actual} | {why it matched or differed} |
| Confidence | {from plan} | {actual} | {e.g., "root cause was correct" or "had to pivot"} |

**If implementation deviated from the plan:**
- {What changed and why}

## Tasks Completed

| # | Task | Status |
|---|------|--------|
| 1 | {task description} | Done |
| 2 | {task description} | Done |
| 3 | {task description} | Skipped — {reason} |

## Validation Results

| Check | Result | Details |
|-------|--------|---------|
| Type check | PASS/FAIL | {notes} |
| Lint | PASS/FAIL | {notes} |
| Unit tests | PASS/FAIL | {X passed, Y failed} |
| Full validation | PASS/FAIL | {notes} |

## Files Changed

| File | Action | Lines Changed |
|------|--------|---------------|
| `{path}` | Created | +{N} |
| `{path}` | Modified | +{N}, -{M} |

## Tests Written

| Test File | Test Cases |
|-----------|-----------|
| `{path}` | {list of test functions} |

## Deviations from Plan

{List any deviations with rationale, or "None"}

## Issues Encountered

{List any problems and how they were resolved, or "None"}

## Open Items

{Anything left undone — "None" if fully complete}
```

---

## Phase 6: ARCHIVE — Move Plan to Completed

```bash
mkdir -p .claude/archon/plans/completed
mv {plan-path} .claude/archon/plans/completed/
```

### Update Source PRD (if applicable)

Check if the plan was generated from a PRD (look for "Source PRD:" in plan or matching filename):

1. Read the PRD file
2. Update the phase status from `in-progress` to `complete`
3. Save the PRD

---

## Phase 7: REPORT — Present and Suggest Next Step

Summarize the implementation:
- Tasks completed vs total
- Validation status
- Assessment vs reality (did complexity/confidence match?)
- Any deviations or issues

Link to the report artifact.

**If from PRD, show progress:**
```
### PRD Progress
**PRD**: `{prd-file-path}`
**Phase Completed**: #{number} - {phase name}
**Next Phase**: {next pending phase, or "All phases complete!"}
To continue: `/archon-dev plan {prd-path}`
```

**Next steps**:
- To commit: `/archon-dev commit`
- To create PR: `/archon-dev pr`
- To review: `/archon-dev review`
