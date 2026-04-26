---
description: 현재 branch에서 implementation context가 포함된 PR 생성
argument-hint: [base-branch] (default: auto-detected from config or repo)
---

# Pull Request 생성

**Base branch override**: $ARGUMENTS
**Default base branch**: $BASE_BRANCH

> If a base branch was provided as argument above, use it for `--base`. Otherwise use the default base branch.

---

## 사전 점검: 기존 PR 확인

Extract the issue number from the current branch name or context (e.g., `fix/issue-580` → `580`).

```bash
BRANCH=$(git branch --show-current)
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | tail -1)
```

If an issue number was found, search for open PRs that already reference it:

```bash
gh pr list \
  --search "Fixes #${ISSUE_NUM} OR Closes #${ISSUE_NUM}" \
  --state open \
  --json number,url,headRefName
```

**If a matching PR is returned**: stop here, report the existing PR URL, and do **not** proceed to Phase 2 or Phase 3.

```
Existing PR found for issue #${ISSUE_NUM}: [url]
Skipping PR creation.
```

**If no match is found** (or no issue number could be extracted): continue to Phase 1.

---

## Phase 1: 수집 context

### 1.1 git 상태 확인

```bash
git branch --show-current
git status --short
git log origin/$BASE_BRANCH..HEAD --oneline
```

### 1.2 implementation report 확인

Look for the most recent implementation report:

```bash
ls -t $ARTIFACTS_DIR/../reports/*-report.md 2>/dev/null | head -1
```

If found, read it to extract:
- Summary of what was implemented
- Files changed
- Validation results
- Any deviations from plan

### 1.3 commit summary 가져오기

```bash
git log origin/$BASE_BRANCH..HEAD --pretty=format:"- %s"
```

---

## Phase 2: 준비 Branch

### 2.1 모든 변경사항 commit 확인

If uncommitted changes exist:

```bash
git status --porcelain
```

**If dirty**:
1. Stage changes: `git add -A`
2. Commit: `git commit -m "Final changes before PR"`

### 2.2 branch push

```bash
git push -u origin HEAD
```

---

## Phase 3: 생성 PR

### 3.1 PR template 확인

Look for the project's PR template at `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, or `docs/PULL_REQUEST_TEMPLATE.md`. Read whichever one exists.

**If template found**: Use it as the structure, fill in **every section** with details from the implementation report and commits. Don't skip sections or leave placeholders.

**If no template**, use this format:

```markdown
## Summary

[Brief description from implementation report or commits]

## Changes

[List from implementation report "Files Changed" section, or from commits]
- file1.ts - description
- file2.ts - description

## Validation

[From implementation report "Validation Results" section]
- [x] Type check passes
- [x] Lint passes
- [x] Tests pass
- [x] Build succeeds

## Testing Notes

[Any manual testing done or integration test results]

---

[If from a GitHub issue, add: Closes #XXX]
```

### 3.2 PR title 결정

**Title**: Concise, imperative mood
- From implementation report summary, OR
- From commit messages

### 3.3 PR 생성

```bash
# Write body to file to avoid shell escaping
cat > $ARTIFACTS_DIR/pr-body.md <<'EOF'
[body from above]
EOF

gh pr create \
  --title "[title]" \
  --body-file $ARTIFACTS_DIR/pr-body.md \
  --base $BASE_BRANCH
```

Or if the content is simple:

```bash
gh pr create --fill --base $BASE_BRANCH
```

After creating the PR, capture its identifiers for downstream steps. Only write artifacts if PR creation succeeded — never persist stale data from a pre-existing PR:

```bash
# After creating the PR, capture and persist the PR number for downstream steps
# IMPORTANT: Only write artifacts after confirmed successful PR creation
if gh pr view --json number,url -q '.number,.url' > /dev/null 2>&1; then
  PR_NUMBER=$(gh pr view --json number -q '.number')
  PR_URL=$(gh pr view --json url -q '.url')
  echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"
  echo "$PR_URL" > "$ARTIFACTS_DIR/.pr-url"
else
  echo "WARNING: Could not confirm PR creation; skipping .pr-number/.pr-url artifacts"
fi
```

---

## Phase 4: output

Report the result:

```markdown
## PR Created

**URL**: [PR URL]
**Branch**: [branch-name] → [base-branch]
**Title**: [PR title]

### Summary
[Brief summary of what the PR contains]

### Next Steps
1. Request review if needed
2. Address any CI failures
3. Merge when approved
```

---

## 오류 처리

### Push할 commit 없음

```
No commits between origin/$BASE_BRANCH and HEAD.
Nothing to create a PR for.
```

### Branch에 이미 PR이 있음

```bash
gh pr view --web
```

Opens the existing PR instead of creating a duplicate.

### Push 실패

1. Check if branch exists remotely: `git ls-remote --heads origin [branch]`
2. If conflicts: `git pull --rebase origin $BASE_BRANCH` then retry push
3. If permission issues: Check GitHub access
