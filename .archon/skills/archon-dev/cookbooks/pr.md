# PR Cookbook

Create well-structured pull requests. Detects PR templates, auto-detects base branch, and links related artifacts. The PR itself is the artifact — no file written.

**Input**: `$ARGUMENTS` — optional PR title hint, `--base <branch>` override, `--draft` for draft PR, or omit for auto-detection.

---

## Phase 0: DETECT — Base Branch

1. **Check arguments**: If `$ARGUMENTS` contains `--base <branch>`, extract that value
2. **Auto-detect from remote**:
   ```bash
   git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
   ```
3. **Fallback**:
   ```bash
   git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}'
   ```
4. **Last resort**: `main`

**Store as `{base-branch}`** — use for ALL comparisons. Never hardcode `main` or `master`.

---

## Phase 1: VALIDATE — Check Prerequisites

### 1.1 Verify Git State

```bash
git branch --show-current
git status --short
git log origin/{base-branch}..HEAD --oneline
```

| State | Action |
|-------|--------|
| On {base-branch} | STOP: "Cannot create PR from {base-branch}. Create a feature branch first." |
| Uncommitted changes | WARN: "You have uncommitted changes. Commit or stash before creating PR." |
| No commits ahead | STOP: "No commits to create PR from. Branch is up to date with {base-branch}." |
| Has commits, clean | PROCEED |

### 1.2 Check for Existing PR

```bash
gh pr list --head $(git branch --show-current) --json number,url
```

**If PR exists:**
```
PR already exists for this branch: {url}
Use `gh pr view` to see details or `gh pr edit` to modify.
```

**CHECKPOINT**: Not on base branch. Working directory is clean. Has commits. No existing PR.

---

## Phase 2: DISCOVER — Gather Context

### 2.1 Check for PR Template

```bash
ls -la .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null
ls -la .github/pull_request_template.md 2>/dev/null
ls -la .github/PULL_REQUEST_TEMPLATE/ 2>/dev/null
```

If not found yet scan the .gothub folder and subfolders to make sure its not there before you move on

**If template found**: Read it and use as the PR body structure.
**If multiple templates**: Use the default or ask user which to use.
**If no template**: Use default format (see Phase 4).

### 2.2 Analyze Commits

```bash
git log origin/{base-branch}..HEAD --pretty=format:"- %s"
git log origin/{base-branch}..HEAD --pretty=format:"%h %s%n%b" --no-merges
```

### 2.3 Analyze Changed Files

```bash
git diff --stat origin/{base-branch}..HEAD
git diff --name-only origin/{base-branch}..HEAD
```

### 2.4 Gather Related Artifacts

Check `.claude/archon/` for artifacts related to this work:

```bash
ls .claude/archon/plans/completed/ 2>/dev/null
ls .claude/archon/reports/ 2>/dev/null
ls .claude/archon/prds/ 2>/dev/null
ls .claude/archon/issues/ 2>/dev/null
```

Match artifacts to the current branch/work by filename and dates.

### 2.5 Determine PR Title

- If single commit: Use commit message as title
- If multiple commits: Summarize the change in imperative mood
- Format: `{type}({scope}): {description}` (under 70 characters)

If `$ARGUMENTS` provides a title hint, use it.

### 2.6 Extract Issue References

From commit messages, find patterns like `Fixes #123`, `Closes #123`, `Relates to #123`, `#123`.

**CHECKPOINT**: Template located (or none). Commits analyzed. Changed files listed. Title determined.

---

## Phase 3: PUSH — Ensure Branch is Remote

```bash
git push -u origin HEAD
```

**If push fails:**
- Check for remote branch conflicts
- May need `--force-with-lease` if rebased (warn user first)

---

## Phase 4: CREATE — Build and Submit PR

### If Template Exists

Read the template and fill in each section based on commits, changes, and artifacts.

### If No Template — Use Default Format

```bash
gh pr create \
  --title "{title}" \
  --base "{base-branch}" \
  {--draft if requested} \
  --body "$(cat <<'EOF'
## Summary

{1-2 sentence description of what this PR accomplishes}

## Changes

{List of commit summaries}
- {commit 1}
- {commit 2}

## Context

{Link to plan/PRD/issue if they exist. Otherwise, brief motivation.}

## Files Changed

{Count} files changed

<details>
<summary>File list</summary>

{list of changed files}

</details>

## Test Plan

- [ ] {validation step 1}
- [ ] {validation step 2}
- [ ] {validation step 3}

## Related Issues

{Any linked issues from commit messages, or "None"}
EOF
)"
```

**Rules from CLAUDE.md:**
- No "Generated with Claude Code" in description
- No AI attribution anywhere
- Write as if a human wrote it

---

## Phase 5: VERIFY — Confirm PR Created

```bash
gh pr view --json number,url,title,state
gh pr checks 2>/dev/null
```

---

## Phase 6: REPORT — Present to User

```markdown
## Pull Request Created

**PR**: #{number}
**URL**: {url}
**Title**: {title}
**Base**: {base-branch} <- {current-branch}

### Summary

{Brief description}

### Changes

- {N} commits
- {M} files changed

### Related Artifacts

- Plan: `{path}` (or "None")
- Report: `{path}` (or "None")

### Checks

{Status of CI checks, or "Pending"}

### Next Steps

- Wait for CI checks to pass
- Request review: `gh pr edit --add-reviewer @username`
- Self-review first: `/archon-dev review {pr-number}`
```

---

## Handling Edge Cases

### Branch has diverged from base

```bash
git fetch origin
git rebase origin/{base-branch}
git push --force-with-lease
```

Warn the user before force-pushing.

### PR template has required sections

Parse template for required sections (often marked with `<!-- required -->`). Ensure all are filled. Warn if any appear incomplete.

### Draft PR requested

If `--draft` in `$ARGUMENTS` or user asks for draft:

```bash
gh pr create --draft --title "{title}" --base "{base-branch}" --body "{body}"
```

Suggest: `/archon-dev review {pr-number}` to self-review before requesting human review.
