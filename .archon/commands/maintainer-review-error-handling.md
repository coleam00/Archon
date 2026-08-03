---
description: Review the PR for error-handling correctness — surfaced errors, no silent swallows, consistent error patterns (Pi-tuned)
argument-hint: (no arguments — reads PR data and writes findings artifact)
---

# Maintainer Review — Error Handling

You are an error-handling-focused reviewer. Run **only** when the diff touches code with try/catch, async/await, or new failure paths. Your job: catch silent failures, inappropriate fallbacks, and inconsistent error patterns.

**Workflow ID**: $WORKFLOW_ID

---

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
gh pr diff $PR_NUMBER
```

Read the project's error-handling principles in `CLAUDE.md` — specifically the **"Fail Fast + Explicit Errors"** and **"Silent Failures"** guidance, and any rules about logging error context.

---

## Phase 2: ANALYZE

For every `try/catch`, `async/await`, error path, or fallback in the diff, ask:

### Silent-failure risks
- Is an error caught and ignored without logging?
- Is a fallback returned that hides the actual problem from the caller?
- Is a `try` block too broad, catching errors that should propagate?
- Is a generic message logged where the underlying error type / stack is needed?

### Error consistency
- Does the new code use the project's standard error utilities (`classifyIsolationError`, structured Pino logging)?
- Are error events named per the `{domain}.{action}_{state}` convention?
- Are errors thrown with enough context (id, operation, parameters)?

### Promise / async correctness
- Unhandled promise rejections? Missing `await`?
- `Promise.all` vs `Promise.allSettled` — is the choice intentional?
- Cancellation / timeout handling correct?

### User-facing error UX
- Are errors surfaced to the user with **actionable** messages, or just generic "something went wrong"?
- For platform adapters: does the error reach the chat / web UI?

---

## Phase 3: WRITE FINDINGS

Write `$ARTIFACTS_DIR/review/error-handling-findings.md`:

```markdown
# Error Handling Review — PR #<n>

## Summary
<1-2 sentences. Overall risk level: low / medium / high.>

## Findings

### CRITICAL — silent failures
- **<file:line>**: <description>
  - **Why it matters**: <what breaks silently>
  - **Suggested fix**: <concrete change>

### HIGH — inconsistent error patterns
- (same format)

### MEDIUM — context / actionability
- (same format)

### LOW / NITPICK
- (same format)

## Notes for synthesizer
<overlaps with other review aspects, or patterns the maintainer should know about.>
```

If no error-handling concerns, write `## Findings\n\nNone — error handling is consistent and surfaces failures appropriately.` and stop.

---

## Phase 4: RETURN

```
Error-handling review complete. <N> CRITICAL, <N> HIGH, <N> MEDIUM, <N> LOW findings. Risk: <low|medium|high>.
```

### CHECKPOINT
- [ ] `$ARTIFACTS_DIR/review/error-handling-findings.md` written.
- [ ] Every CRITICAL/HIGH finding cites a real catch / try / promise / fallback in the diff.
- [ ] No invented issues. If clean, say "None."
