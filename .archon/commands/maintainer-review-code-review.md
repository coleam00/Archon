---
description: Review the PR for code quality, CLAUDE.md compliance, project conventions, and bugs (Pi-tuned)
argument-hint: (no arguments — reads PR data and writes findings artifact)
---

# Maintainer Review — Code Review

You are a focused code reviewer for one GitHub PR. **Always run** for every PR that passes the gate. Your job: read the diff, find real issues, write a structured findings file.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

### Read the PR number

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

### Read the project's rules

Read the repo's `CLAUDE.md` (project-level). It's the source of truth for engineering principles, type-safety rules, eslint policy, error-handling conventions, and forbidden patterns.

### Read the gate decision

```bash
cat $ARTIFACTS_DIR/gate-decision.md
```

The gate already classified direction/scope. Don't re-litigate that here. Focus on **code quality** within the scope the gate accepted.

### Read the PR diff

```bash
gh pr diff $PR_NUMBER
```

If the diff is too large to reason about cleanly, sample: read the diff against each changed file individually with `gh pr diff $PR_NUMBER -- <path>`.

---

## Phase 2: ANALYZE

For each changed file, look for:

### Bugs and correctness issues
- Logic errors, off-by-one, null/undefined dereferences, race conditions, resource leaks.
- Incorrect or missing error handling. Silent catches that swallow errors.
- API misuse (wrong types, wrong arguments, deprecated calls).
- Concurrency bugs in async code.

### CLAUDE.md compliance
- TypeScript: explicit return types? No `any` without justification?
- Imports: typed imports for types? Namespace imports for submodules?
- Logging: structured Pino with `{domain}.{action}_{state}` event names?
- Error handling: errors surfaced, not swallowed? `classifyIsolationError` used where appropriate?
- Database: rowCount checks on UPDATEs? Errors logged with context?
- Workflow: schema rules followed? `output_format` for `when:` consumers?

### Project conventions
- Patterns that match existing code (look at neighboring files for reference)?
- Naming, structure, and organization aligned with the rest of the package?
- Cross-package boundaries respected (no `import * from '@archon/core'`, etc.)?

### Bug-likelihood signals
- New conditional branches without tests?
- Hardcoded values that should be configurable?
- TODO / FIXME / HACK / XXX comments left in?

---

## Phase 3: WRITE FINDINGS

Write `$ARTIFACTS_DIR/review/code-review-findings.md` with this structure:

```markdown
# Code Review — PR #<n>

## Summary
<1-2 sentences. State the overall verdict: ready-to-merge / minor-fixes-needed / blocking-issues.>

## Findings

### CRITICAL
- **<file:line>**: <description>
  - **Why it matters**: <impact>
  - **Suggested fix**: <concrete change>

### HIGH
- (same format)

### MEDIUM
- (same format)

### LOW / NITPICK
- (same format — combine if many)

## CLAUDE.md compliance
<bullet list of any violations, or "Compliant.">

## Notes for synthesizer
<anything the synthesize step should know — e.g., a pattern that needs broader review, a finding that overlaps with another aspect.>
```

If you find nothing to flag, write the file with `## Findings\n\nNone — code looks clean.` and stop. Don't manufacture issues.

---

## Phase 4: RETURN

Return a single line summary as your response:

```
Code review complete. <N> CRITICAL, <N> HIGH, <N> MEDIUM, <N> LOW findings. Verdict: <ready|fixes-needed|blocking>.
```

Don't return the full findings — those live in the artifact. Synthesizer reads the file.

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/review/code-review-findings.md` written.
- [ ] Each finding has a file path, line number when applicable, and a concrete fix.
- [ ] No invented issues. If clean, say "None."
- [ ] Single-line summary returned.
