---
description: Technical code review for quality, bugs, and CLAUDE.md compliance
---

# Code Review: Pre-Commit Quality Check

## Objective

Perform a thorough technical code review on recently changed files, checking for bugs, security issues, and adherence to Archon's documented conventions.

## Process

### 1. Gather Codebase Context

Read the project conventions to understand what standards to enforce:
- Read `CLAUDE.md` for project-wide conventions
- Read any relevant `.claude/rules/` files for domain-specific patterns

### 2. Identify Changes to Review

```bash
git status
git diff HEAD
git diff --stat HEAD
```

Check for new untracked files:
```bash
git ls-files --others --exclude-standard
```

Read each new file in its entirety. Read each changed file in its entirety (not just the diff) to understand full context.

### 3. Review Checklist

For each changed or new file, analyze for:

**Logic Errors**
- Off-by-one errors, incorrect conditionals
- Missing error handling or silent failures
- Race conditions (especially in async/streaming code)
- Incorrect TypeScript type narrowing

**Security Issues**
- SQL injection in raw queries
- XSS in rendered content
- Exposed secrets or API keys
- Insecure data handling

**Performance Problems**
- N+1 database queries
- Missing cleanup (event listeners, intervals, AbortControllers)
- Unnecessary re-renders in React components
- Unbounded array growth

**Type Safety**
- Use of `any` without justification
- Missing type annotations on functions
- Incorrect type assertions (`as` casts)
- Overly broad types where narrow types exist

**Archon-Specific Conventions**
- Import patterns: `import type` for type-only imports, no `import * as core`
- Use `execFileAsync` not `exec` for git operations
- Never `git clean -fd`
- Structured Pino logging with `{domain}.{action}_{state}` event naming
- `bun run test` not `bun test` from repo root
- `mock.module()` isolation (separate test batches for conflicting mocks)
- ESLint zero-warnings policy

**Package Boundary Compliance**
- No circular dependencies between packages
- `@archon/git` and `@archon/paths` must not import from `@archon/core`
- `@archon/workflows` injects deps via narrow interfaces, not direct core imports

### 4. Verify Issues Are Real

- Confirm type errors by checking actual TypeScript definitions
- Validate security concerns with context
- Ensure flagged patterns are actually violations, not false positives
- **High-confidence only (80+)** — do not flag style preferences or pre-existing issues

### 5. Output

Save to: `.agents/code-reviews/[descriptive-name].md`

**Stats:**
- Files Modified: X
- Files Added: X
- New lines: +X
- Deleted lines: -X

**For each issue found:**
```
severity: critical|high|medium|low
file: path/to/file.ts
line: 42
issue: [one-line description]
detail: [explanation of why this is a problem]
suggestion: [how to fix it, with code if helpful]
convention: [CLAUDE.md section reference if applicable]
```

If no issues found: "Code review passed. No technical issues detected."

## Important

- Be specific — line numbers, not vague complaints
- Focus on real bugs, not style preferences
- Suggest fixes, don't just complain
- Flag security issues as CRITICAL
- Reference CLAUDE.md conventions when applicable
- Do NOT flag pre-existing issues in unchanged code
