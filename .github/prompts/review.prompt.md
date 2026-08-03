---
description: "Code review - reviews PRs, files, folders, or any code scope"
argument-hint: "<pr-number|file|folder|scope>"
agent: "agent"
tools:
  - codebase
  - readFile
  - textSearch
  - usages
  - runInTerminal
  - problems
  - runTests
  - editFiles
  - createFile
  - createDirectory
---

# Code Review

**Input**: ${input:scope}

## Your Mission

Perform a thorough code review:
1. **Understand** what you're reviewing and its purpose
2. **Check** the code against project patterns
3. **Run** validation (type-check, lint, tests)
4. **Identify** issues by severity
5. **Report** findings

**Golden Rule**: Be constructive and actionable. Every issue should have a clear recommendation.

---

## Phase 1: DETERMINE SCOPE

### Parse Input

| Input Type | Example | Action |
|------------|---------|--------|
| PR number | `123`, `#123` | Fetch PR diff with `gh pr diff 123` |
| PR URL | `github.com/.../pull/123` | Extract number, fetch PR diff |
| File path | `src/api/flags.ts` | Review single file |
| Folder path | `server/src/` | Review all files in folder |
| Blank | (none) | Review unstaged git changes |

### Get Review Target

**For PR:**
```bash
gh pr view {NUMBER} --json number,title,author,files
gh pr diff {NUMBER}
```

**For file/folder:**
```bash
find {path} -name "*.ts" -o -name "*.tsx" | grep -v node_modules
```

**For blank (unstaged changes):**
```bash
git diff --name-only
git diff
```

---

## Phase 2: CONTEXT

### Read Project Rules

- Read `copilot-instructions.md` for project conventions
- Understand the patterns in the codebase

### Understand Intent

- For PRs: Read title and description
- For files: Understand the file's purpose in the codebase
- For changes: What was modified and why?

---

## Phase 3: REVIEW

### Review Each File

For each file in scope, check:

| Category | Check |
|----------|-------|
| **Correctness** | Does the code work as intended? |
| **Type Safety** | Are types explicit, no implicit `any`? |
| **Patterns** | Does it follow existing codebase patterns? |
| **Error Handling** | Are errors handled appropriately? |
| **Tests** | Are there tests for this code? |

### Categorize Issues

| Severity | Criteria |
|----------|----------|
| **Critical** | Security issues, data loss, crashes |
| **High** | Type violations, missing error handling, logic errors |
| **Medium** | Pattern inconsistencies, missing edge cases |
| **Low** | Style suggestions, minor improvements |

---

## Phase 4: VALIDATE

Run automated checks:

```bash
# Type check
pnpm run build

# Lint
pnpm run lint

# Tests
pnpm test
```

---

## Phase 5: REPORT

### Create Report

**Output path**: `.agents/reviews/{scope-name}-review.md`

```bash
mkdir -p .agents/reviews
```

```markdown
# Code Review: {SCOPE}

**Scope**: {PR #N / file path / folder path / unstaged changes}
**Recommendation**: {APPROVE/NEEDS WORK}

## Summary

{2-3 sentences: What was reviewed and overall assessment}

## Issues Found

### Critical
{List or "None"}

### High Priority
{List or "None"}

### Medium Priority
{List or "None"}

### Suggestions
{List or "None"}

## Validation Results

| Check | Status |
|-------|--------|
| Type Check | {PASS/FAIL} |
| Lint | {PASS/FAIL} |
| Tests | {PASS/FAIL} |

## What's Good

{Acknowledge positive aspects}

## Recommendation

{What needs to happen next}
```

### Post to GitHub (if PR)

```bash
gh pr review {NUMBER} --comment --body-file .agents/reviews/pr-{NUMBER}-review.md
```

---

## Phase 6: OUTPUT

```markdown
## Review Complete

**Scope**: {what was reviewed}
**Recommendation**: {APPROVE/NEEDS WORK}

### Issues Found

| Severity | Count |
|----------|-------|
| Critical | {N} |
| High | {N} |
| Medium | {N} |

### Validation

| Check | Result |
|-------|--------|
| Type Check | {PASS/FAIL} |
| Lint | {PASS/FAIL} |
| Tests | {PASS/FAIL} |

### Report

`.agents/reviews/{scope-name}-review.md`
```
