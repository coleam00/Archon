---
description: PIV loop — prime the agent with deep codebase + task understanding before planning.
argument-hint: <github-issue-number | feature description | path to a plan file>
---

# PIV Prime: Load Task + Codebase Context

**Workflow ID**: $WORKFLOW_ID

You are starting a PIV (Plan → Implement → Validate) loop. This is the first phase. Your job
is to deeply understand BOTH the task and the codebase before any planning happens, then
write a primer artifact the rest of the workflow depends on.

**Request**: $ARGUMENTS

---

## Phase 1: LOAD THE TASK

Determine what the request is and load it.

**If it is a GitHub issue** (a `#123` reference, a bare number, or an issue URL):
- Fetch it: `gh issue view <number> --json title,body,labels,comments,state,url`
- Treat the issue title, body, and comments as the authoritative task definition.

**If it is a path to a plan file** (ends in `.md`):
- Read the file. Summarize it. The PIV loop will refine or execute it.

**If it is free text**:
- This is a feature idea or bug description. Use it directly as the task.

If the request is ambiguous, note the ambiguity explicitly — the prime-review gate that
follows will let a human resolve it.

### PHASE_1_CHECKPOINT
- [ ] Task source identified (issue / plan file / free text)
- [ ] Task definition captured (title, intent, acceptance signals)

## Phase 2: EXPLORE THE CODEBASE

Do your homework before the human reviews your understanding.

1. **Project structure** — list tracked files (`git ls-files`), map the directory layout.
2. **Core documentation** — read `CLAUDE.md` (or equivalent), root and module `README`s,
   any architecture docs and `.claude/references/` or `docs/` material.
3. **Key files** — main entry points, configuration (`package.json`, `pyproject.toml`,
   `Cargo.toml`, etc.), and the specific files this task will most likely touch.
4. **Current state** — `git log -10 --oneline` and `git status` for recent activity.
5. **Related code** — search for existing implementations similar to the task. Note
   patterns, conventions, and components that can be reused or extended.

### PHASE_2_CHECKPOINT
- [ ] Project type, tech stack, and tooling identified
- [ ] Architecture and conventions understood
- [ ] Files relevant to this task located (with paths)

## Phase 3: GENERATE THE PRIMER

Write `$ARTIFACTS_DIR/prime.md` with this structure:

```markdown
# PIV Primer

## Task
- Source: [issue #N / plan file / description]
- Goal: [restated understanding in 2-3 sentences]
- Acceptance signals: [how we will know it is done]

## Project Overview
- Purpose and type of application
- Primary languages, frameworks, tooling (test / lint / type-check / build commands)

## Architecture & Conventions
- Overall structure, key patterns, important directories
- Naming, error-handling, logging, and testing conventions observed

## Relevant Code
- `path/to/file` (lines) — what it does, how it relates to this task
- [patterns / components that could be extended or reused]

## Initial Approach Thoughts
- [approach 1 — extend existing X]
- [approach 2 — fallback]
- [key architectural decisions that need a human's input]

## Open Questions
- [anything ambiguous that the prime-review gate should resolve]
```

### PHASE_3_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/prime.md` written and complete
- [ ] Every "Relevant Code" entry has a real, verified file path
- [ ] Open questions surfaced for the human gate

## Phase 4: REPORT

Output a concise summary for the human reviewing this phase:
- What the task is, in your words
- What already exists that is relevant
- Your initial approach and the key decisions you need a human to weigh in on

End by telling the human: the prime-review gate is next — they can correct your
understanding, point you at code you missed, or approve to move to planning.
