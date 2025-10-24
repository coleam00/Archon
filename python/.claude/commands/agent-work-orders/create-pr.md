# Create GitHub Pull Request

Create a GitHub pull request for the current branch with auto-generated description.

## Variables

- Branch name: $1
- PRP file path: $2 (optional - may be empty)

## Instructions

**Prerequisites Check:**

1. Verify gh CLI is authenticated:
   ```bash
   gh auth status || {
     echo "Error: gh CLI not authenticated. Run: gh auth login"
     exit 1
   }
   ```

2. Verify we're in a git repository:
   ```bash
   git rev-parse --git-dir >/dev/null 2>&1 || {
     echo "Error: Not in a git repository"
     exit 1
   }
   ```

3. Verify changes are pushed to remote:
   ```bash
   BRANCH=$(git branch --show-current)
   git rev-parse --verify origin/$BRANCH >/dev/null 2>&1 || {
     echo "Error: Branch '$BRANCH' not pushed to remote. Run: git push -u origin $BRANCH"
     exit 1
   }
   ```

**Step 1: Gather Information**

1. Get current branch name:
   ```bash
   BRANCH=$(git branch --show-current)
   ```

2. Get default base branch (usually main or master):
   ```bash
   BASE=$(git remote show origin | grep 'HEAD branch' | cut -d' ' -f5)
   # Fallback to main if detection fails
   [ -z "$BASE" ] && BASE="main"
   ```

3. Get repository info:
   ```bash
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   ```

**Step 2: Generate PR Title**

Convert branch name to conventional commit format:

**Rules:**
- `feat/add-user-auth` → `feat: add user authentication`
- `fix/login-bug` → `fix: resolve login bug`
- `docs/update-readme` → `docs: update readme`
- Capitalize first letter after prefix
- Remove hyphens, replace with spaces
- Keep concise (under 72 characters)

**Step 3: Find PR Template**

Look for PR template in these locations (in order):

1. `.github/pull_request_template.md`
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. `.github/PULL_REQUEST_TEMPLATE/pull_request_template.md`
4. `docs/pull_request_template.md`

```bash
PR_TEMPLATE=""
if [ -f ".github/pull_request_template.md" ]; then
  PR_TEMPLATE=".github/pull_request_template.md"
elif [ -f ".github/PULL_REQUEST_TEMPLATE.md" ]; then
  PR_TEMPLATE=".github/PULL_REQUEST_TEMPLATE.md"
elif [ -f ".github/PULL_REQUEST_TEMPLATE/pull_request_template.md" ]; then
  PR_TEMPLATE=".github/PULL_REQUEST_TEMPLATE/pull_request_template.md"
elif [ -f "docs/pull_request_template.md" ]; then
  PR_TEMPLATE="docs/pull_request_template.md"
fi
```

**Step 4: Generate PR Body**

**If PR template exists:**
- Read template content
- Fill in placeholders if present
- If PRP file provided: Extract summary and insert into template

**If no PR template (use default):**

```markdown
## Summary
[Brief description of what this PR does]

## Changes
[Bullet list of key changes from git log]

## Implementation Details
[Reference PRP file if provided, otherwise summarize commits]

## Testing
- [ ] All existing tests pass
- [ ] New tests added (if applicable)
- [ ] Manual testing completed

## Related Issues
Closes #[issue number if applicable]
```

**Auto-fill logic:**

1. **Summary section:**
   - If PRP file exists: Extract "Feature Description" section
   - Otherwise: Use first commit message body
   - Fallback: Summarize changes from `git diff --stat`

2. **Changes section:**
   - Get commit messages: `git log $BASE..$BRANCH --pretty=format:"- %s"`
   - List modified files: `git diff --name-only $BASE...$BRANCH`
   - Format as bullet points

3. **Implementation Details:**
   - If PRP file exists: Link to it with `See: $PRP_FILE_PATH`
   - Extract key technical details from PRP "Solution Statement"
   - Otherwise: Summarize from commit messages

4. **Testing section:**
   - Check if new test files were added: `git diff --name-only $BASE...$BRANCH | grep test`
   - Auto-check test boxes if tests exist
   - Include validation results from execute.md if available

**Step 5: Create Pull Request**

```bash
gh pr create \
  --title "$PR_TITLE" \
  --body "$PR_BODY" \
  --base "$BASE" \
  --head "$BRANCH" \
  --web
```

**Flags:**
- `--web`: Open PR in browser after creation
- If `--web` not desired, remove it

**Step 6: Capture PR URL**

```bash
PR_URL=$(gh pr view --json url -q .url)
```

**Step 7: Link to Issues (if applicable)**

If PRP file or commits mention issue numbers (#123), link them:

```bash
# Extract issue numbers from commits
ISSUES=$(git log $BASE..$BRANCH --pretty=format:"%s %b" | grep -oP '#\K\d+' | sort -u)

# Link issues to PR
for ISSUE in $ISSUES; do
  gh pr comment $PR_URL --body "Relates to #$ISSUE"
done
```

**Important Notes:**

- NEVER mention Claude Code, Anthropic, AI, or co-authoring in PR
- PR title and body should be professional and clear
- Include all relevant context for reviewers
- Link to PRP file in repo if available
- Auto-check completed checkboxes in template

## Report

Output ONLY the PR URL (no markdown, no explanations, no quotes):

https://github.com/owner/repo/pull/123

**Example output:**
```
https://github.com/coleam00/archon/pull/456
```

## Error Handling

If PR creation fails:
- Check if PR already exists for branch: `gh pr list --head $BRANCH`
- If exists: Return existing PR URL
- If other error: Output error message with context
