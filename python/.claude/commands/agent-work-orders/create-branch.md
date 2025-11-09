# Create Git Branch

Generate a conventional branch name based on user request and create a new git branch.

## Variables

User request: $1

## Instructions

**Step 1: Check Current Branch**

- Check current branch: `git branch --show-current`
- Check if on main/master:
  ```bash
  CURRENT_BRANCH=$(git branch --show-current)
  if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
    echo "Warning: Currently on branch '$CURRENT_BRANCH', not main/master"
    echo "Proceeding with branch creation from current branch"
  fi
  ```
- Note: We proceed regardless, but log the warning

**Step 2: Generate Branch Name**

Use conventional branch naming:

**Prefixes:**
- `feat/` - New feature or enhancement
- `fix/` - Bug fix
- `chore/` - Maintenance tasks (dependencies, configs, etc.)
- `docs/` - Documentation only changes
- `refactor/` - Code refactoring (no functionality change)
- `test/` - Adding or updating tests
- `perf/` - Performance improvements

**Naming Rules:**
- Use kebab-case (lowercase with hyphens)
- Be descriptive but concise (max 50 characters)
- Remove special characters except hyphens
- No spaces, use hyphens instead

**Examples:**
- "Add user authentication system" → `feat/add-user-auth`
- "Fix login redirect bug" → `fix/login-redirect`
- "Update README documentation" → `docs/update-readme`
- "Refactor database queries" → `refactor/database-queries`
- "Add unit tests for API" → `test/api-unit-tests`

**Branch Name Generation Logic:**
1. Analyze user request to determine type (feature/fix/chore/docs/refactor/test/perf)
2. Extract key action and subject
3. Convert to kebab-case
4. Truncate if needed to keep under 50 chars
5. Validate name is descriptive and follows conventions

**Step 3: Check Branch Exists**

- Check if branch name already exists:
  ```bash
  if git show-ref --verify --quiet refs/heads/<branch-name>; then
    echo "Branch <branch-name> already exists"
    # Append version suffix
    COUNTER=2
    while git show-ref --verify --quiet refs/heads/<branch-name>-v$COUNTER; do
      COUNTER=$((COUNTER + 1))
    done
    BRANCH_NAME="<branch-name>-v$COUNTER"
  fi
  ```
- If exists, append `-v2`, `-v3`, etc. until unique

**Step 4: Create and Checkout Branch**

- Create and checkout new branch: `git checkout -b <branch-name>`
- Verify creation: `git branch --show-current`
- Ensure output matches expected branch name

**Step 5: Verify Branch State**

- Confirm branch created: `git branch --list <branch-name>`
- Confirm currently on branch: `[ "$(git branch --show-current)" = "<branch-name>" ]`
- Check remote tracking: `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "No upstream set"`

**Important Notes:**

- NEVER mention Claude Code, Anthropic, AI, or co-authoring in any output
- Branch should be created locally only (no push yet)
- Branch will be pushed later by commit.md command
- If user request is unclear, prefer `feat/` prefix as default

## Report

Output ONLY the branch name (no markdown, no explanations, no quotes):

<branch-name>

**Example outputs:**
```
feat/add-user-auth
fix/login-redirect-issue
docs/update-api-documentation
refactor/simplify-middleware
```
