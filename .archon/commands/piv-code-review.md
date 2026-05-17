---
description: PIV loop — technical code review of the changes for bugs, security, and standards.
argument-hint: (no arguments — reviews the changes on the current branch)
---

# PIV Code Review

**Workflow ID**: $WORKFLOW_ID

Perform a technical code review of the changes made in this PIV run.

## Review philosophy

- Simplicity is the goal — every line should justify its existence.
- Code is read far more than written — optimize for readability.
- Focus on real bugs, not style. Flag security issues as CRITICAL.

---

## Phase 1: LOAD CONTEXT

- Read `$ARTIFACTS_DIR/plan.md` — what was supposed to be built.
- Read `$ARTIFACTS_DIR/implementation.md` — what was built and any divergences.
- Read `$ARTIFACTS_DIR/validation.md` — current validation status.
- Read `CLAUDE.md`, the relevant `README`s, and any documented standards in `docs/` or
  `.claude/references/` to understand the codebase's conventions.

Gather the diff:

```bash
git status
git diff $BASE_BRANCH...HEAD --stat
git diff $BASE_BRANCH...HEAD
git ls-files --others --exclude-standard
```

Read each changed file and each new file **in full** — not just the diff — for context.

### PHASE_1_CHECKPOINT
- [ ] Plan, implementation report, and validation report loaded
- [ ] Codebase standards understood
- [ ] Every changed and new file read in full

## Phase 2: ANALYZE

For each changed or new file, check for:

1. **Logic errors** — off-by-one, wrong conditionals, missing error handling, race conditions.
2. **Security issues** — injection, XSS, insecure data handling, exposed secrets or keys.
3. **Performance** — N+1 queries, inefficient algorithms, memory leaks, needless work.
4. **Code quality** — DRY violations, overly complex functions, poor naming, missing types.
5. **Standards adherence** — matches documented conventions, linting/typing/logging/testing
   standards, and the patterns the plan said to follow.
6. **Plan adherence** — was each planned task implemented correctly? Do acceptance criteria hold?

Verify issues are real before reporting them — run a specific test, confirm a type error,
validate a security concern in context. Do not report speculative problems.

### PHASE_2_CHECKPOINT
- [ ] Every changed file analyzed across all six dimensions
- [ ] Each reported issue verified as real

## Phase 3: GENERATE THE REVIEW

Write `$ARTIFACTS_DIR/code-review.md`:

```markdown
# Code Review

## Stats
- Files modified: N
- Files added: N
- Lines: +X -Y

## Issues

severity: critical | high | medium | low
file: path/to/file
line: N
issue: [one-line description]
detail: [why this is a problem]
suggestion: [how to fix it]

[repeat per issue — or "No technical issues detected."]

## Plan Adherence
| Task | Status | Notes |
|------|--------|-------|
| {task} | DONE / PARTIAL / MISSING | {notes} |

## Recommendation: READY / NEEDS FIXES
```

### PHASE_3_CHECKPOINT
- [ ] `$ARTIFACTS_DIR/code-review.md` written
- [ ] Each issue has a severity, a precise location, and a concrete fix suggestion

## Phase 4: REPORT

Summarize: number of issues by severity, plan-adherence status, and the overall
recommendation (READY or NEEDS FIXES).
