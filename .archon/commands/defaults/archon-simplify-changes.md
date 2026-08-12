---
description: Simplify code changed in this PR — implements fixes directly, commits, and pushes
argument-hint: (none - operates on the current branch diff against $BASE_BRANCH)
---

# Simplify Changed Code

---

## IMPORTANT: Output Behavior

**Your output will be posted as a GitHub comment.** Keep working output minimal:
- Do NOT narrate each step
- Do NOT output verbose progress updates
- Only output the final structured report at the end

---

## Your Mission

Review ALL code changed on this branch and implement simplifications directly. You are not advisory — you edit files, validate, commit, and push.

## Scope

**Only code changed in this PR** — run `git diff $BASE_BRANCH...HEAD --name-only` to get the file list. Do not touch unrelated files.

## What to Simplify

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

## Rules

- **Preserve exact functionality** — simplification must not change behavior
- **Clarity over brevity** — readable beats compact
- **No speculative refactors** — only simplify what's obviously improvable
- **Follow project conventions** — read CLAUDE.md before making changes
- **Small, obvious changes** — each simplification should be self-evidently correct

## Process

### Phase 1: ANALYZE

1. Read CLAUDE.md for project conventions
2. Get changed files — this is your **scope allow-list**; you may edit nothing outside it:
   ```bash
   git fetch origin "$BASE_BRANCH" 2>/dev/null || true
   # $ARTIFACTS_DIR, not /tmp: Archon runs workflows concurrently and worktree
   # isolation does not isolate /tmp, so a fixed host-global path lets two runs
   # clobber each other's allow-list and revert each other's legitimate edits.
   git diff "origin/$BASE_BRANCH"...HEAD --name-only | sort -u > "$ARTIFACTS_DIR/simplify-allowlist.txt"
   cat "$ARTIFACTS_DIR/simplify-allowlist.txt"
   ```
3. Read each changed file
4. Identify simplification opportunities per file

### Phase 2: IMPLEMENT

For each simplification:
1. Edit the file
2. Run `bun run type-check` — if it fails, revert that change
3. Run `bun run lint` — if it fails, fix or revert

**Track every path you edit.** You will need this list in Phase 3 to stage only the files you touched.

### Phase 3: VALIDATE & COMMIT

1. Run full validation: `bun run type-check && bun run lint`
2. **Scope gate (hard, self-enforcing).** Auto-revert any out-of-scope edits — do not
   wait for manual judgment. Simplify never adds files and never touches anything
   outside the PR diff:
   ```bash
   # Auto-revert any out-of-scope edits — do not wait for manual judgment
   while IFS= read -r oos_file; do
     [ -z "$oos_file" ] && continue
     echo "SCOPE LEAK — reverting out-of-scope edit: $oos_file"
     if git ls-files --error-unmatch "$oos_file" 2>/dev/null; then
       git checkout -- "$oos_file"
     else
       rm -f "$oos_file"
     fi
   done < <(comm -23 <({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u) "$ARTIFACTS_DIR/simplify-allowlist.txt")
   # Verify clean. Untracked files are unioned in above and here: `git diff
   # --name-only` alone lists only tracked changes, so a stray NEW out-of-scope
   # file would slip past a gate that explicitly claims to `rm` such files.
   REMAINING=$(comm -23 <({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u) "$ARTIFACTS_DIR/simplify-allowlist.txt")
   if [ -n "$REMAINING" ]; then
     echo "ERROR: Could not revert all out-of-scope files: $REMAINING" >&2
     exit 1
   fi
   ```
   Report any reverts in the Phase 4 summary — a simplification that touched an
   out-of-scope file is a scope leak, not a simplification.
3. If simplifications were applied, stage **only** the files you edited in Phase 2 — never `git add -A`, `git add .`, or `git add -u`:
   ```bash
   # Stage by name, using the list you tracked in Phase 2
   git add path/to/file1.ts path/to/file2.ts
   # Verify nothing else snuck in
   git status --porcelain
   ```
4. **Never stage** report, scratch, or PR-body artifacts, even if they show up as untracked or modified in the worktree:
   - Anything under `$ARTIFACTS_DIR` (the artifacts directory normally lives outside the worktree, but copies/symlinks may exist)
   - `review/`, `simplify-report.md`, `*-report.md` at the repo root
   - `.pr-body.md`, `pr-body.md`, `*.scratch.md`, `*.tmp.md`
   - Repo-local Archon telemetry: `.archon/artifacts/`, `.archon/logs/`, `.archon/state/` (local-only — never in git)
   - If `git status --porcelain` shows files you don't recognize as part of your simplifications, leave them unstaged
5. Commit and push only the staged source edits:
   ```bash
   git commit -m "simplify: reduce complexity in changed files"
   git push
   ```
6. If no simplifications were applied, skip the commit entirely

### Phase 4: REPORT

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
