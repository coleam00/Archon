---
description: Fix bugs found in code review
argument-hint: "[code-review-file-or-description] [scope]"
---

# Code Review Fix

I ran a code review and found these issues:

Code review (file or description): $1

Scope: $2

## Process

If the code review is a file, read the entire file first to understand all issues.

For each fix:
1. Explain what was wrong and why
2. Show the fix with before/after context
3. Create and run relevant tests to verify

After all fixes, run validation:

```bash
bun run validate
```

Fix any issues that arise until all checks pass:
- Type checking: `bun run type-check`
- Linting: `bun run lint` (zero warnings enforced)
- Formatting: `bun run format:check`
- Tests: `bun run test`
