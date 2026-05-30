---
description: Determine PR review scope from local git diff (no forge query required)
argument-hint: (none - uses current branch and $BASE_BRANCH)
---

# PR Review Scope (Local)

**Local-only version** - No network required, no PR API calls.

---

## Your Mission

Determine review scope from local git changes without querying GitHub/GitLab PR.

1. Analyze local git diff against base branch
2. Categorize changed files
3. Identify review priorities
4. Write scope artifact for downstream review agents

**Output artifact**: `$ARTIFACTS_DIR/review/scope.md`

---

## Phase 1: GIT CONTEXT - Gather Local State

### 1.1 Get Branch Information

```bash
CURRENT=$(git branch --show-current)
BASE=$BASE_BRANCH
echo "Current branch: $CURRENT"
echo "Base branch: $BASE"
```

### 1.2 Get File Changes

```bash
# Get all changed files with their status
git diff --name-status $BASE..HEAD
```

### 1.3 Get Commit Info

```bash
# Count commits ahead of base
COMMITS_AHEAD=$(git rev-list --count $BASE..HEAD)
echo "Commits ahead: $COMMITS_AHEAD"

# Get commit messages
git log --oneline $BASE..HEAD
```

### 1.4 Get Diff Stats

```bash
git diff --stat $BASE..HEAD
```

**PHASE_1_CHECKPOINT:**

- [ ] Current and base branches identified
- [ ] File changes retrieved
- [ ] Commit count calculated
- [ ] Diff stats available

---

## Phase 2: CATEGORIZE - Group Files by Type

### 2.1 Categorize Changed Files

Group files into categories:

**Core Implementation:**
- Source files (*.ts, *.tsx, *.js, *.jsx, *.py, *.go, etc.)
- Exclude: test files, config files

**Tests:**
- Test files (*.test.ts, *.spec.ts, *_test.py, etc.)
- Test utilities and fixtures

**Documentation:**
- README files, doc comments
- Markdown files in docs/
- JSDoc/docstring changes

**Configuration:**
- Package manifests (package.json, pyproject.toml)
- Config files (tsconfig.json, .eslintrc, etc.)
- CI/CD files (.github/workflows/*, .gitlab-ci.yml)

**Database/Schema:**
- Migration files
- Schema definitions
- ORM models

**Other:**
- Assets, styles, etc.

Example categorization:

```bash
# Count files by category
CORE_FILES=$(git diff --name-only $BASE..HEAD | grep -E '\.(ts|tsx|js|jsx|py|go)$' | grep -v test | wc -l)
TEST_FILES=$(git diff --name-only $BASE..HEAD | grep -E '\.test\.|\.spec\.|_test\.' | wc -l)
DOC_FILES=$(git diff --name-only $BASE..HEAD | grep -E '\.md$|^docs/' | wc -l)
CONFIG_FILES=$(git diff --name-only $BASE..HEAD | grep -E 'package\.json|tsconfig|\.eslintrc|\.yml$' | wc -l)
```

**PHASE_2_CHECKPOINT:**

- [ ] Files categorized by type
- [ ] Category counts calculated

---

## Phase 3: PRIORITIZE - Identify Review Focus Areas

### 3.1 Determine Review Priorities

Based on file patterns and project context, identify:

**Critical paths** (always high priority):
- Authentication/authorization code
- Security-sensitive operations
- Data persistence/database operations
- API endpoints and handlers
- Payment/financial logic

**High-complexity areas** (needs thorough review):
- New architectural patterns
- Complex algorithms
- Concurrency/async code
- Error handling paths
- Type system boundaries

**Standard review** (routine check):
- Typical feature implementation
- Test additions
- Documentation updates
- Configuration changes

**Low priority** (quick scan):
- Formatting/style-only changes
- Comment updates
- Asset updates

### 3.2 Identify Patterns

Look for:
- New dependencies added
- Breaking changes (API signature changes)
- Performance-sensitive code
- Security patterns (input validation, sanitization)
- Error handling completeness

**PHASE_3_CHECKPOINT:**

- [ ] Critical paths identified
- [ ] High-complexity areas flagged
- [ ] Review priorities assigned

---

## Phase 4: ARTIFACT - Write Scope Document

### 4.1 Write Scope Artifact

Write to `$ARTIFACTS_DIR/review/scope.md`:

```markdown
# Review Scope (Local)

**Generated**: {YYYY-MM-DD HH:MM}
**Source**: Local git diff

---

## Branch Context

| Field | Value |
|-------|-------|
| **Current Branch** | {current-branch} |
| **Base Branch** | {base-branch} |
| **Commits Ahead** | {count} |

---

## Changes Summary

**Total files changed**: {count}

| Category | Count | Files |
|----------|-------|-------|
| Core Implementation | {n} | {list-core-files} |
| Tests | {n} | {list-test-files} |
| Documentation | {n} | {list-doc-files} |
| Configuration | {n} | {list-config-files} |
| Other | {n} | {list-other-files} |

---

## Diff Stats

```
{git-diff-stat-output}
```

---

## Review Priorities

### Critical Paths 🔴

{List files touching auth/security/database/api with rationale}

Examples:
- `src/auth/middleware.ts` - Authentication logic changes
- `src/db/migrations/001_users.sql` - Schema migration

### High Complexity 🟡

{List complex/architectural changes with rationale}

Examples:
- `src/engine/executor.ts` - New DAG execution engine
- `src/concurrency/pool.ts` - Worker pool implementation

### Standard Review 🟢

{List routine implementation files}

### Low Priority ⚪

{List formatting/comment-only changes}

---

## Scope Limits

**In Scope:**
- {key-areas-requiring-review}
- {example: "All changes to authentication flow"}
- {example: "New API endpoints and their tests"}

**Out of Scope:**
- {areas-excluded-from-review}
- {example: "Auto-generated type definitions"}
- {example: "Vendor dependencies"}

---

## Patterns Identified

**New Dependencies**: {yes/no - list if present}
**Breaking Changes**: {yes/no - list if present}
**Security-Sensitive**: {yes/no - areas identified}
**Performance-Critical**: {yes/no - areas identified}

---

## Commit Messages

{git-log-output}

---

## Next Steps

Parallel review agents will now analyze:
1. Code quality (archon-code-review-agent)
2. Error handling (archon-error-handling-agent)
3. Test coverage (archon-test-coverage-agent)
4. Comment quality (archon-comment-quality-agent)
5. Documentation impact (archon-docs-impact-agent)

Each agent will use this scope to focus their review.
```

**PHASE_4_CHECKPOINT:**

- [ ] Scope artifact written
- [ ] All categories documented
- [ ] Priorities clearly marked

---

## Phase 5: OUTPUT - Report Summary

```markdown
## Review Scope Determined ✅

**Workflow ID**: `$WORKFLOW_ID`

### Files Changed

| Category | Count |
|----------|-------|
| Core Implementation | {n} |
| Tests | {n} |
| Documentation | {n} |
| Configuration | {n} |
| Other | {n} |

### Review Priorities

- 🔴 Critical paths: {count}
- 🟡 High complexity: {count}
- 🟢 Standard review: {count}
- ⚪ Low priority: {count}

### Artifact

Scope written to: `$ARTIFACTS_DIR/review/scope.md`

### Next Step

Proceeding to parallel review agents.
```

---

## Error Handling

### No Changes Found

If no changes between base and current:

```markdown
ℹ️ No changes to review

Current branch `{branch}` is even with `{base}`.
```

### Detached HEAD

If not on a branch:

```markdown
⚠️ Detached HEAD state

Current: {commit-sha}
Base: {base-branch}

Proceeding with review based on commit diff.
```

### Cannot Determine Base

If `$BASE_BRANCH` not set or branch doesn't exist:

```markdown
❌ Cannot determine base branch

Set $BASE_BRANCH or ensure branch exists.
Default: 'main' or 'master'
```

---

## Success Criteria

- **SCOPE_DETERMINED**: Files categorized and prioritized
- **ARTIFACT_WRITTEN**: `review/scope.md` created
- **PRIORITIES_CLEAR**: Critical paths and complexity areas identified
- **NO_NETWORK**: No forge API calls made
