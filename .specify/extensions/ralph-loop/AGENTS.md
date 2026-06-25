# Ralph Agent Instructions

You are an autonomous coding agent working on a software project.

## File Locations (Environment Variables)

`ralph.sh` exports `RALPH_PRD_FILE` and `RALPH_PROGRESS_FILE` before invoking
the agent. Resolution order inside `ralph.sh`:

1. Caller-supplied env var (`RALPH_PRD_FILE` / `RALPH_PROGRESS_FILE`)
2. `.specify/feature.json` keys `ralph_prd_file` / `ralph_progress_file`
   (written by `/speckit-tasks-to-ralph`; relative paths resolve against repo root)
3. Fallback: `prd.json` / `progress.txt` next to `ralph.sh`

Always read/write these paths via the env vars — do NOT hardcode `prd.json` or `progress.txt`. The spec feature directory (containing `tasks.md`) is the parent of `$RALPH_PRD_FILE`.

## PRD Schema (v3 — batch per iteration)

The PRD groups tasks into **batches** (`userStories[]`).

```json
{
  "userStories": [
    {
      "title": "Phase 1: Setup",
      "completed": false,
      "tasks": [
        { "id": "T001", "passes": false, ... },
        { "id": "T002", "passes": false, ... }
      ],
      "tasksIds": ["T001", "T002"]
    }
  ]
}
```

**Invariant** (you must maintain): `batch.completed == all(t.passes for t in batch.tasks)`.

## Your Task (per iteration)

1. Read the PRD at `$RALPH_PRD_FILE`.
2. Read `tasks.md` under PRD `specDirectory`.
3. Check the **Codebase Patterns** section at the top of `$RALPH_PROGRESS_FILE`.
4. Read the rest of `$RALPH_PROGRESS_FILE` for prior-iteration context.
5. Verify you're on the branch named in PRD `branchName`. If not, check it out (or create from `main`).
6. **Pick the first batch where `completed: false`** (lowest array index). This is your active batch this iteration.
7. **Read relevant `LESSONS.md` files before editing active-batch tasks.** For each task or parallel run-group you are about to implement, identify likely touched directories from the task description, acceptance criteria, and existing codebase patterns. Read any nearby `LESSONS.md` files in those directories or parent directories up to the repo root, then apply those lessons as local implementation constraints, gotchas, testing notes, and dependency reminders.
8. **Within that batch**, walk `tasks[]` in array order. **First check for a parallel run-group** (see "Parallel Task Execution" below); if found, dispatch it as one swarm, then resume sequential walking from the next `passes:false` task. For each task with `passes: false`:
   1. Implement it.
   2. Run quality checks (typecheck, lint, test — whatever the project requires).
   3. If a check fails: fix it, re-run. Do NOT leave broken code in working tree.
   4. Set the task's `passes: true` in `$RALPH_PRD_FILE`.
   5. **Do NOT commit per task and do NOT append progress per task.** Keep changes staged/unstaged in the working tree and accumulate task notes mentally (or in a scratch buffer) until the end of the iteration.
9. **After flipping each task**, check whether _every_ `tasks[].passes` in the active batch is now `true`. If yes, set the batch's `completed: true` in `$RALPH_PRD_FILE`.
10. **Stay inside the active batch** — do NOT cross batch boundaries within a single iteration. (Exception: if step 9 just flipped `completed:true` AND budget remains, you MAY proceed to the next `completed:false` batch — but commit the just-finished batch FIRST per step 14 before starting the next.)
11. If budget is tight (response getting long, context filling), STOP after the current task — leaving `completed:false` is fine. The next iteration will resume from your first `passes:false` task automatically.
12. **At the end of the iteration — append ONE progress entry covering the whole batch of work done this iter** to `$RALPH_PROGRESS_FILE` (see format below). The entry lists every task you flipped `passes:true` this iter, plus aggregated learnings.
13. Update LESSONS.md files if you discovered reusable patterns (see below).
14. **Commit per batch — exactly one commit per iteration via `speckit-git-commit`.** Right after step 13:
    - Determine the commit message:
      - If the active batch's `completed:true` flipped this iter → `feat: [Batch Title] - implemented [N] tasks` (e.g. `feat: Phase 1: Setup - implemented 9 tasks`).
      - If the active batch is still `completed:false` (partial work) → `feat: [Batch Title] (partial) - [TFIRST..TLAST]` (e.g. `feat: Phase 7: Settings (partial) - T210..T215`).
    - Set the message in `.specify/extensions/git/git-config.yml` under `auto_commit.after_implement.message` (and ensure `auto_commit.after_implement.enabled: true`).
    - Invoke the `speckit-git-commit` skill with event `after_implement` (runs `.specify/extensions/git/scripts/bash/auto-commit.sh after_implement`). The skill stages all changes (`git add .`) and commits with the configured message — covering all task changes + the PRD edits + the progress.txt append + any LESSONS.md updates in one commit.
    - The commit MUST include the staged PRD update (`passes:true` flips, optional `completed:true` flip), the progress.txt append, and any LESSONS.md updates.
    - Do NOT run raw `git commit -m ...` — always go through `speckit-git-commit`.

## Parallel Task Execution

Some tasks in a batch carry the `[P]` marker (parallel-safe, originating from spec-kit `tasks.md`). The marker is preserved in **`task.description`** (it's stripped from `task.title` by the generator but kept in description). `[P]`-tagged tasks have **no inter-dependencies and touch disjoint files**, so they can run concurrently inside the active batch.

> **Detection rule:** a task is parallel-safe iff its `description` contains the literal token `[P]` (whitespace-bounded). No separate `isParallelable` field exists — `[P]` in description IS the signal.

### Detection

Walking `tasks[]` in array order, when you hit a `passes:false` task whose description contains `[P]`, look ahead at the next contiguous tasks. The **run-group** = the maximal contiguous run of `passes:false` tasks where every task's description contains `[P]`. The run-group ends at:

- the first `passes:false` task whose description lacks `[P]`, OR
- a task already `passes:true` (treat as boundary), OR
- the end of the batch.

A single `[P]` task with no `[P]` neighbors → just run sequentially. No swarm overhead for one task.

### Swarming Rule

- **Hard cap: max 4 concurrent sub-agents.** If the run-group has >4 tasks, dispatch the first 4 in parallel, await all, then dispatch the next chunk of up to 4. Never exceed 4 in flight.
- **One task per sub-agent.** No sub-agent owns multiple tasks in the same wave — keeps blast radius and file ownership clean.
- **One message, multiple `Agent` tool calls.** Send all sub-agent dispatches in a single tool-use block so they actually run in parallel (per orchestration-protocol).
- Pick `subagent_type` per task content: `fullstack-developer` for code/tests/UI, `tester` for pure test-writing tasks, `researcher` for spec lookups. Default to `fullstack-developer` if unsure.

### Sub-agent Prompt Template

Every dispatched sub-agent receives a self-contained prompt:

```
Task: <task.id> — <task.description>
Acceptance criteria: <task.acceptanceCriteria joined>
Files you own: <explicit globs/paths derived from task text>
Files you may READ but NOT edit: <other parallel tasks' file globs>
Constraints:
  - Do NOT edit $RALPH_PRD_FILE or $RALPH_PROGRESS_FILE.
  - Do NOT commit, push, or run git operations.
  - Run typecheck/lint scoped to your owned files; report PASS/FAIL.
  - Return: status (DONE | BLOCKED), files changed, 1-line summary.
Work context: <repo root>
Plan reference: <spec dir>/tasks.md (read-only)
```

### Merge & Verification (after the swarm returns)

**One agent = one task = one attempt.** No agent gets a second turn — failure means close it and spawn a fresh one.

1. Collect all sub-agent results. For each agent's task:
   - **Reported `DONE`** → run scoped quality checks (typecheck + lint + targeted tests on that task's owned files).
   - **Reported `BLOCKED` / failure** → task stays `passes:false`. Skip to step 3.
2. **Run full integration check once** across the whole run-group (typecheck + lint + test on the merged tree). This catches cross-file regressions the per-task scoped checks missed.
3. **For every task whose checks failed** (per-task OR integration-attributable):
   - Keep its `passes:false` — do NOT flip.
   - The original agent is closed (its turn is over).
   - **Spawn a fresh sub-agent** for that exact task with the SAME prompt template, plus an extra section: `Previous attempt failed. Failure output: <stderr/diagnostic excerpt>. Files already changed by prior attempt: <git diff summary>. You may keep, revise, or revert those changes.`
   - Re-run the swarm wave with only the failed tasks (still capped at 4 in flight).
4. **Retry cap: 1 fresh-agent retry per task.** If the second agent also fails → leave task `passes:false`, log it in the iteration's progress entry under "Failed tasks (carried to next iter)", and proceed. Do NOT block the rest of the batch.
5. Flip `passes:true` in `$RALPH_PRD_FILE` for every task that genuinely passed (single jq edit covering all of them is fine).
6. Continue walking the batch from the task immediately after the run-group.

### Safety Rails (when in doubt → fall back to sequential)

Run sequentially even if tasks carry `[P]` when:

- Task descriptions reveal **shared file ownership** (e.g. two tasks both edit `package.json`, same module's barrel `index.ts`, same migration file). Sub-agents must own disjoint files.
- A task touches **shared infrastructure** (root config, `tsconfig.json`, schema files, DI module wiring) — concurrent edits will collide.
- The current Codebase Patterns section in `$RALPH_PROGRESS_FILE` flags this area as serial-only.
- The active batch is a "Setup" phase whose tasks bootstrap each other implicitly.

When falling back, just walk the run-group sequentially. The `[P]` marker is a hint, not a mandate.

### Backward Compatibility

If no task in the batch carries `[P]` (older PRDs or batches with hard sequencing), the swarm path is skipped entirely — pure sequential walk per step 8.

## Progress Report Format

APPEND to `$RALPH_PROGRESS_FILE` (never replace, always append) — exactly
**one entry per iteration**, listing every task you flipped this iter:

```
## [Date/Time] - [Batch Title] (iter [N])
**Tasks completed this iter:** T### (Title), T### (Title), ...
**Status:** completed:true | partial (X/Y tasks)

- Per-task summary lines:
  - T### — what was implemented; files changed
  - T### — what was implemented; files changed
  - ...

**Learnings for future iterations:**
- Patterns discovered (e.g., "this codebase uses X for Y")
- Gotchas encountered (e.g., "don't forget to update Z when changing W")
- Useful context (e.g., "the evaluation panel is in component X")
---
```

Replace `[N]` with the iteration number if you can infer it (e.g. by
counting prior `## ` entries). If unsure, use the date/time only. Don't
split this into per-task entries — the progress log is _iteration-grain_,
matching the commit log (one commit ↔ one progress entry).

The learnings section is critical - it helps future iterations avoid repeating mistakes and understand the codebase better.

## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of `$RALPH_PROGRESS_FILE` (create it if it doesn't exist). This section should consolidate the most important learnings:

```
## Codebase Patterns
- Example: Use `sql<number>` template for aggregations
- Example: Always use `IF NOT EXISTS` for migrations
- Example: Export types from actions.ts for UI components
```

Only add patterns that are **general and reusable**, not story-specific details.

## Update LESSONS.md Files

Before committing, check if any edited files have learnings worth preserving in nearby LESSONS.md files:

1. **Identify directories with edited files** - Look at which directories you modified
2. **Check for existing LESSONS.md** - Look for LESSONS.md in those directories or parent directories
3. **Add valuable learnings** - If you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good LESSONS.md additions:**

- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Tests require the dev server running on PORT 3000"
- "Field names must match the template exactly"

**Do NOT add:**

- Story-specific implementation details
- Temporary debugging notes
- Information already in `$RALPH_PROGRESS_FILE`

Only update LESSONS.md if you have **genuinely reusable knowledge** that would help future work in that directory.

## Quality Requirements

- ALL commits must pass your project's quality checks (typecheck, lint, test)
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Browser Testing (If Available)

For any story that changes UI, verify it works in the browser if you have browser testing tools configured (e.g., via MCP):

1. Navigate to the relevant page
2. Verify the UI changes work as expected
3. Take a screenshot if helpful for the progress log

If no browser tools are available, note in your progress report that manual browser verification is needed.

## Stop Condition

After updating the PRD, check if every batch has `completed: true`.

If ALL batches are complete, reply with:
<promise>COMPLETE</promise>

Otherwise end your response normally — the next iteration will pick the first `completed:false` batch automatically.

## Important

- Work inside ONE batch per iteration. Resume the same batch in the next iter if you didn't finish.
- **Commit per batch (= per iteration), not per task — always via `speckit-git-commit`.** Exactly one commit at the end of every iteration. Bundle all task implementations + PRD flips + progress entries into that single commit. Set the message in `git-config.yml` (`auto_commit.after_implement.message`) using `feat: [Batch Title]` for full-batch commits or `feat: [Batch Title] (partial) - T###..T###` for partial, then invoke the skill with event `after_implement`. Never run raw `git commit -m ...`.
- Maintain the invariant: `batch.completed == all(tasks[].passes)`. If you flip the last `passes:true` in a batch, also flip its `completed:true` in the same edit.
- The `tasksIds` field is denormalized for convenience — leave it alone (it equals `[tasks[].id]` and never changes within a run).
- Keep the working tree green per task: run quality checks after EACH task implementation (or once per run-group when swarming). Don't bundle broken code into the iteration commit.
- Read the Codebase Patterns section in `$RALPH_PROGRESS_FILE` before starting.
- **Parallel run-groups: max 4 sub-agents in flight.** See "Parallel Task Execution" — file-ownership disjointness is mandatory; fall back to sequential whenever in doubt.
