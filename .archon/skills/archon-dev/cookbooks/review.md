# Review Cookbook

Structured code review for PRs or local changes. Deploys parallel review agents for thorough coverage.

**Input**: `$ARGUMENTS` — PR number, PR URL, branch name, or omit for local uncommitted changes. Optional: `--approve`, `--request-changes`.

---

## Phase 1: SCOPE — Determine What to Review

### 1.1 Parse Input

| Input Format | Action |
|--------------|--------|
| Number (`123`, `#123`) | Use as PR number |
| URL (`https://github.com/.../pull/123`) | Extract PR number |
| Branch name (`feature-x`) | Find associated PR: `gh pr list --head {name} --json number -q '.[0].number'` |
| No arguments | Use local changes (`git diff` + `git diff --staged`) |

### 1.2 Get PR Metadata (if PR)

```bash
gh pr view {NUMBER} --json number,title,body,author,headRefName,baseRefName,state,additions,deletions,changedFiles,files
gh pr diff {NUMBER}
gh pr diff {NUMBER} --name-only
```

### 1.3 Validate PR State

| State | Action |
|-------|--------|
| `MERGED` | STOP: "PR already merged. Nothing to review." |
| `CLOSED` | WARN: "PR is closed. Review anyway? (historical analysis)" |
| `DRAFT` | NOTE: "Draft PR — focusing on direction, not polish" |
| `OPEN` | PROCEED with full review |

### 1.4 Checkout PR Branch (if PR)

```bash
gh pr checkout {NUMBER}
```

**CHECKPOINT**: Diff obtained. Scope understood. PR state is reviewable.

---

## Phase 2: CONTEXT — Read Project Standards

### 2.1 Read CLAUDE.md

Extract key constraints: type safety, code style, testing requirements, architecture patterns.

### 2.2 Find Implementation Artifacts

Check `.claude/archon/` for artifacts related to this work:

```bash
ls .claude/archon/reports/ 2>/dev/null
ls .claude/archon/plans/completed/ 2>/dev/null
ls .claude/archon/issues/ 2>/dev/null
ls .claude/archon/debug/ 2>/dev/null
```

**If implementation report exists:**
1. Read the report and referenced plan
2. Note documented deviations — these are INTENTIONAL, not issues
3. Only flag **undocumented** deviations

**If no implementation report**: Note in review that no report was found.

### 2.3 Read Affected Files

Read the full files being changed (not just the diff) — context matters. Check for related test files.

**CHECKPOINT**: Project rules understood. Implementation artifacts located. Changed files read.

---

## Phase 3: REVIEW — Deploy Parallel Agents

Launch 2-4 review agents in parallel using the Agent tool:

### Agent 1: Correctness & Logic (`code-reviewer`)
**Always launch.** Write a detailed prompt describing the specific changes, files affected, and what to look for. Ask it to check correctness, logic bugs, edge cases, error handling, and adherence to CLAUDE.md conventions.

### Agent 2: Silent Failures & Error Handling (`silent-failure-hunter`)
**Always launch.** Write a detailed prompt describing the changed files. Ask it to hunt for swallowed errors, inappropriate fallbacks, missing error propagation.

### Agent 3: Test Coverage (`pr-test-analyzer`)
**Launch if code changes (not just docs/config).** Describe what functionality changed and ask it to evaluate behavioral coverage gaps.

### Agent 4: Simplification (`code-simplifier`)
**Launch if changes are substantial (>100 lines).** Describe the changed code and ask for simplification opportunities that preserve exact functionality.

---

## Phase 4: SYNTHESIZE — Merge and Prioritize

After all agents return:

1. **Deduplicate** findings across agents
2. **Check against implementation report** — documented deviations are intentional, not issues
3. **Categorize** by severity:
   - **Critical** (must fix): Bugs, security issues, data loss risks
   - **High** (should fix): Logic errors, missing error handling, type safety violations
   - **Medium** (consider): Pattern inconsistencies, undocumented deviations, missing edge cases
   - **Low** (nit): Style preferences, minor optimizations
4. **Verify** top findings yourself — read the actual code to confirm

---

## Phase 5: VALIDATE — Run Automated Checks

Detect project runner and run validation:

```bash
# Type checking
{runner} run type-check

# Linting
{runner} run lint

# Tests
{runner} run test

# Full validation (if available)
{runner} run validate
```

Capture pass/fail status, error count, and specific failures for each.

---

## Phase 6: DECIDE — Form Recommendation

**APPROVE** if:
- No critical or high issues
- All validation passes
- Code follows patterns
- Changes match PR intent

**REQUEST CHANGES** if:
- High priority issues exist
- Validation fails but is fixable
- Missing tests for new functionality

**BLOCK** if:
- Critical security or data issues
- Fundamental approach is wrong
- Breaking changes without migration

| Situation | Handling |
|-----------|----------|
| Draft PR | Comment only, no approve/block |
| Large PR (>500 lines) | Note thoroughness limits, suggest splitting |
| Security-sensitive | Extra scrutiny, err on caution |

---

## Phase 7: WRITE — Save Review Artifact

Save to `.claude/archon/reviews/{date}-pr-{number}.md` (or `{date}-{slug}.md` for local changes).

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Code Review

**Target**: PR #{number} / local changes on {branch}
**Date**: {YYYY-MM-DD}
**Files Reviewed**: {count}
**Verdict**: APPROVE / REQUEST_CHANGES / BLOCK

---

## Summary

{2-3 sentence overall assessment}

## Implementation Context

| Artifact | Path |
|----------|------|
| Implementation Report | `{path}` or "Not found" |
| Original Plan | `{path}` or "Not found" |
| Documented Deviations | {count} or "N/A" |

---

## Critical Issues

### {issue title}
**File**: `{path}:{line}`
**Problem**: {description}
**Fix**: {suggested fix}

## High Priority

### {issue title}
**File**: `{path}:{line}`
**Problem**: {description}
**Suggestion**: {suggested improvement}

## Medium Priority

...

## Low Priority / Nits

...

---

## Validation Results

| Check | Status | Details |
|-------|--------|---------|
| Type Check | {PASS/FAIL} | {notes} |
| Lint | {PASS/WARN} | {count} warnings |
| Tests | {PASS/FAIL} | {count} passed |
| Full validation | {PASS/FAIL} | {notes} |

## Pattern Compliance

- [{x}] Follows existing code structure
- [{x}] Type safety maintained
- [{x}] Naming conventions followed
- [{x}] Tests added for new code
- [{x}] Documentation updated

## What's Good

{Positive observations — what was done well}

## Recommendation

**{APPROVE/REQUEST CHANGES/BLOCK}**

{Clear explanation and what needs to happen next}
```

---

## Phase 8: PUBLISH — Post to GitHub (if PR)

```bash
# Determine review action based on recommendation and flags
# If --approve AND no critical/high issues:
gh pr review {NUMBER} --approve --body-file .claude/archon/reviews/{filename}.md

# If --request-changes OR high issues:
gh pr review {NUMBER} --request-changes --body-file .claude/archon/reviews/{filename}.md

# Otherwise just comment:
gh pr comment {NUMBER} --body-file .claude/archon/reviews/{filename}.md
```

If reviewing a PR, ask the user whether to post findings as a PR comment before posting.

---

## Phase 9: REPORT — Present to User

Summarize the review:
- Verdict (approve/request changes/block)
- Count of issues by severity
- Top 3 most important findings
- Validation results

Link to the artifact. If PR, include the PR comment URL.

Suggest: `/archon-dev review {pr-number}` to self-review before requesting human review.
