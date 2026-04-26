---
description: 이 PR에서 변경된 코드를 단순화 — 직접 수정, commit, push 수행
argument-hint: (none - operates on the current branch diff against $BASE_BRANCH)
---

# 변경 코드 단순화

---

## 중요: 출력 방식

**Your output will be posted as a GitHub comment.** Keep working output minimal:
- Do NOT narrate each step
- Do NOT output verbose progress updates
- Only output the final structured report at the end

---

## 미션

Review ALL code changed on this branch and implement simplifications directly. You are not advisory — you edit files, validate, commit, and push.

## 범위

**Only code changed in this PR** — run `git diff $BASE_BRANCH...HEAD --name-only` to get the file list. Do not touch unrelated files.

## 단순화 대상

| Opportunity | What to Look For |
|-------------|------------------|
| **Unnecessary complexity** | Deep nesting, convoluted logic paths |
| **Redundant code** | Duplicated logic, unused variables/imports |
| **Over-abstraction** | Abstractions that obscure rather than clarify |
| **Poor naming** | Unclear variable/function names |
| **Nested ternaries** | Multiple conditions in ternary chains — use if/else |
| **Dense one-liners** | Compact code that sacrifices readability |
| **Obvious comments** | Comments that describe what code clearly shows |
| **Inconsistent patterns** | Code that doesn't follow project conventions (read CLAUDE.md) |

## 규칙

- **Preserve exact functionality** — simplification must not change behavior
- **Clarity over brevity** — readable beats compact
- **No speculative refactors** — only simplify what's obviously improvable
- **Follow project conventions** — read CLAUDE.md before making changes
- **Small, obvious changes** — each simplification should be self-evidently correct

## 프로세스

### 1단계: 분석

1. Read CLAUDE.md for project conventions
2. Get changed files: `git diff $BASE_BRANCH...HEAD --name-only`
3. Read each changed file
4. Identify simplification opportunities per file

### 2단계: 구현

For each simplification:
1. Edit the file
2. Run `bun run type-check` — if it fails, revert that change
3. Run `bun run lint` — if it fails, fix or revert

### 3단계: VALIDATE & COMMIT

1. Run full validation: `bun run type-check && bun run lint`
2. If changes were made:
   ```bash
   git add -A
   git commit -m "simplify: reduce complexity in changed files"
   git push
   ```
3. If no simplifications found, skip commit

### 4단계: 보고

Write report to `$ARTIFACTS_DIR/review/simplify-report.md` and output:

```markdown
## Code Simplification Report

### Changes Made

#### 1. [Brief Title]
**File**: `path/to/file.ts:45-60`
**Type**: Reduced nesting / Improved naming / Removed redundancy / etc.
**Before**: [snippet]
**After**: [snippet]

---

### Summary

| Metric | Value |
|--------|-------|
| Files analyzed | X |
| Simplifications applied | Y |
| Net line change | -N lines |
| Validation | PASS / FAIL |

### No Changes Needed
(If nothing to simplify, say so — "Code is already clean. No simplifications applied.")
```
