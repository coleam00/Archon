---
description: Create a PR from current branch with implementation context
argument-hint: [base-branch] (default: auto-detected from config or repo)
---

# Create Pull Request

**Base branch override**: $ARGUMENTS
**Default base branch**: $BASE_BRANCH

> If a base branch was provided as argument above, use it for `--base`. Otherwise use the default base branch.

---

## Pre-flight: Detect Repos and Existing PRs

Resolve the push remote and PR target before doing anything else:

```bash
BRANCH=$(git branch --show-current)
PUSH_REMOTE=$(git config --get "branch.$BRANCH.remote" || echo origin)
BASE_REMOTE=$(git remote | grep -qx upstream && echo upstream || echo "$PUSH_REMOTE")
HEAD_REPO=$(gh repo view --repo "$(git remote get-url "$PUSH_REMOTE")" --json nameWithOwner -q .nameWithOwner)
BASE_REPO=$(gh repo view --repo "$(git remote get-url "$BASE_REMOTE")" --json nameWithOwner -q .nameWithOwner)
BASE_BRANCH=${ARGUMENTS:-$BASE_BRANCH}
```

Extract the issue number from the current branch name or context (e.g., `fix/issue-580` -> `580`).

```bash
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | tail -1)
```

If an issue number was found, search for open PRs that already reference it in the base repo:

```bash
gh pr list \
  --repo "$BASE_REPO" \
  --search "Fixes #${ISSUE_NUM} OR Closes #${ISSUE_NUM}" \
  --state open \
  --json number,url,headRefName
```

If a matching PR is returned: stop here, report the existing PR URL, and do not proceed.

---

## Phase 1: Gather Context

### 1.1 Check Git State

```bash
git branch --show-current
git status --short
git log "$BASE_REMOTE/$BASE_BRANCH"..HEAD --oneline
```

### 1.2 Check for Implementation Report

Look for the most recent implementation report:

```bash
ls -t "$ARTIFACTS_DIR"/../reports/*-report.md 2>/dev/null | head -1
```

If found, read it to extract:
- Summary of what was implemented
- Files changed
- Validation results
- Any deviations from plan

### 1.3 Get Commit Summary

```bash
git log "$BASE_REMOTE/$BASE_BRANCH"..HEAD --pretty=format:"- %s"
```

---

## Phase 2: Prepare Branch

### 2.1 Ensure All Changes Committed

If uncommitted changes exist:

```bash
git status --porcelain
```

If dirty:
1. Stage changes: `git add -A`
2. Commit: `git commit -m "Final changes before PR"`

### 2.2 Push Branch

```bash
git push -u "$PUSH_REMOTE" HEAD
```

---

## Phase 3: Create PR

### 3.1 Check for PR Template

Look for the project's PR template at `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, or `docs/PULL_REQUEST_TEMPLATE.md`. Read whichever one exists.

### 3.2 Determine PR Title

Title: concise, imperative mood.

### 3.3 Create the PR

When `HEAD_REPO` differs from `BASE_REPO`, use explicit cross-repo targeting:

```bash
HEAD_OWNER=$(echo "$HEAD_REPO" | cut -d/ -f1)

gh pr create \
  --repo "$BASE_REPO" \
  --head "$HEAD_OWNER:$BRANCH" \
  --base "$BASE_BRANCH" \
  --title "[title]" \
  --body-file "$ARTIFACTS_DIR/pr-body.md"
```

If the repo is same-repo, the explicit `--head` form still works and keeps behavior deterministic.

After creating the PR, capture its identifiers for downstream steps:

```bash
PR_NUMBER=$(gh pr view --repo "$BASE_REPO" --json number -q '.number')
PR_URL=$(gh pr view --repo "$BASE_REPO" --json url -q '.url')
echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"
echo "$PR_URL" > "$ARTIFACTS_DIR/.pr-url"
```

---

## Phase 4: Output

Report:

```markdown
## PR Created

**URL**: [PR URL]
**Branch**: [branch-name] -> [base-branch]
**Head Repo**: [head-repo]
**Base Repo**: [base-repo]
**Title**: [PR title]
```

---

## Error Handling

### No Commits to Push

`No commits between $BASE_REMOTE/$BASE_BRANCH and HEAD.`

### Branch Already Has PR

```bash
gh pr view --repo "$BASE_REPO" --web
```

### Push Fails

1. Check if branch exists remotely: `git ls-remote --heads "$PUSH_REMOTE" "$BRANCH"`
2. If conflicts: `git pull --rebase "$BASE_REMOTE" "$BASE_BRANCH"` then retry push
3. If permission issues: check access to the fork remote
