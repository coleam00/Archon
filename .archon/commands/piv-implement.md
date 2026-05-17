---
description: PIV loop — implement the approved plan task-by-task with validation at every step.
argument-hint: (no arguments — reads the plan from workflow artifacts)
---

# PIV Implement: Execute the Plan

**Workflow ID**: $WORKFLOW_ID

The plan has been reviewed and approved by a human. Implement it in one pass — task by task,
validating as you go.

**Golden rule**: If validation fails, fix it before moving on. Never leave broken code.

---

## Phase 1: LOAD

- Read `$ARTIFACTS_DIR/plan.md` in full — this is your sole implementation guide.
- Read `CLAUDE.md` for project conventions.
- Read every file the plan's "Files to Read Before Implementing" section lists.
- `git status` and `git log -5 --oneline` to confirm the starting state.

### PHASE_1_CHECKPOINT
- [ ] Plan read and understood end to end
- [ ] All "files to read" from the plan have been read
- [ ] Conventions and starting git state confirmed

## Phase 2: EXECUTE

For EACH task in the plan's "Step-by-Step Tasks" section, in order:

1. **Read** the target file (if it exists) and the PATTERN file the task references.
2. **Implement** the change exactly as the task specifies. Mirror the cited pattern.
   Maintain the codebase's existing style, types, and error-handling conventions.
3. **Check syntax** immediately after each file change — run the task's `VALIDATE` command
   if it has one, or a quick type/syntax check otherwise.
4. **Fix** any issue before moving to the next task.

Do not skip tasks. Do not reorder them unless a dependency genuinely requires it — if you
must diverge from the plan, note what and why (the execution report will capture it).

### PHASE_2_CHECKPOINT
- [ ] Every task in the plan implemented
- [ ] Each file change syntax-checked
- [ ] Divergences from the plan noted with reasons

## Phase 3: TEST

- Create every test file the plan's "Testing Strategy" specifies.
- Implement all test cases listed, including edge cases.
- Run the tests; fix the implementation until they pass.

### PHASE_3_CHECKPOINT
- [ ] All planned test files created
- [ ] All planned test cases implemented and passing

## Phase 4: GENERATE THE IMPLEMENTATION REPORT

Write `$ARTIFACTS_DIR/implementation.md`:

```markdown
# Implementation Summary

## Tasks Completed
- Task N: {title} — {files created/modified}

## Files
- Created: [paths]
- Modified: [paths]

## Tests Added
- [test files and the cases they cover]

## Divergences from the Plan
- {what changed vs the plan, and why} — or "None"

## Notes
- {anything the plan did not anticipate, issues encountered}
```

### PHASE_4_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/implementation.md` written
- [ ] Divergences and notes captured honestly

## Phase 5: COMMIT

Commit the implementation so the worktree branch has the changes. Do NOT push.

```bash
git add -A
git status --short
git commit -m "<type>: <concise description of the implemented change>"
```

Use a conventional-commit type (`feat`, `fix`, `refactor`, etc.). Stage only project files —
never commit secrets or local environment files.

### PHASE_5_CHECKPOINT
- [ ] All implementation changes committed to the worktree branch
- [ ] Nothing pushed (push happens in the finalize phase)

## Phase 6: REPORT

Summarize for the workflow: tasks completed, files changed, tests added, the commit made,
and whether the implementation is ready for the validate phase.
