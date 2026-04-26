---
description: 변경사항 commit, template 기반 PR 생성, review 준비 상태 표시
argument-hint: (no arguments - reads from workflow artifacts)
---

# Pull Request 마무리

**Workflow ID**: $WORKFLOW_ID

---

## 미션

Finalize the implementation and create the PR:
1. Commit all changes
2. Push to remote
3. Create PR using project's template (if exists)
4. Mark PR as ready for review

---

## 1단계: 로드 — context 수집

### 1.1 workflow artifacts 로드

```bash
cat $ARTIFACTS_DIR/plan-context.md
cat $ARTIFACTS_DIR/implementation.md
cat $ARTIFACTS_DIR/validation.md
```

Extract:
- Plan title and summary
- Branch name
- Files changed
- Tests written
- Validation results
- Deviations from plan (if any)

### 1.2 PR template 확인

**IMPORTANT**: Always check for the project's PR template first. Look for it at `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, or `docs/PULL_REQUEST_TEMPLATE.md`. Read whichever one exists.

**If template found**: Use it as the structure, fill in **every section** with implementation details.
**If no template**: Use the default format defined in Phase 3.

### 1.3 기존 PR 확인

```bash
gh pr list --head $(git branch --show-current) --json number,url,state
```

**If PR already exists**: Will update it instead of creating new one.
**If no PR**: Will create new one.

**PHASE_1_CHECKPOINT:**

- [ ] Artifacts loaded
- [ ] Template identified (or using default)
- [ ] Existing PR status known

---

## 2단계: 커밋 — 변경사항 stage 및 commit

### 2.1 확인 Git 상태

```bash
git status --porcelain
```

### 2.2 stage 변경사항

Stage all implementation changes:

```bash
git add -A
```

**Review staged files** - ensure no sensitive files (.env, credentials) are included:

```bash
git diff --cached --name-only
```

### 2.3 commit 생성

Create a descriptive commit message:

```bash
git commit -m "{summary of implementation}

- {key change 1}
- {key change 2}
- {key change 3}

{If from plan/issue: Implements #{number}}
"
```

### 2.4 remote에 push

```bash
git push origin HEAD
```

**PHASE_2_CHECKPOINT:**

- [ ] All changes staged
- [ ] No sensitive files included
- [ ] Commit created
- [ ] Pushed to remote

---

## 3단계: 생성/업데이트 — pull request

### 3.1 PR body 준비

**If project has PR template**, fill in each section with implementation details:
- Replace placeholder text with actual content
- Fill in checkboxes based on what was done
- Keep the template's structure intact

**If no template**, use this default format:

```markdown
## Summary

{Brief description from plan summary}

## Changes

{From implementation.md "Files Changed" section}

| File | Action | Description |
|------|--------|-------------|
| `src/x.ts` | CREATE | {what it does} |
| `src/y.ts` | UPDATE | {what changed} |

## Tests

{From implementation.md "Tests Written" section}

- `src/x.test.ts` - {test descriptions}
- `src/y.test.ts` - {test descriptions}

## Validation

{From validation.md}

- [x] Type check passes
- [x] Lint passes
- [x] Format passes
- [x] All tests pass ({N} tests)
- [x] Build succeeds

## Implementation Notes

{If deviations from plan:}
### Deviations from Plan

{List deviations and reasons}

{If issues encountered:}
### Issues Resolved

{List issues and resolutions}

---

**Plan**: `{plan-source-path}`
**Workflow ID**: `$WORKFLOW_ID`
```

### 3.2 PR 생성 또는 업데이트

**If no PR exists**, create one:

```bash
# Write prepared body to file to avoid shell escaping
cat > $ARTIFACTS_DIR/pr-body.md <<'EOF'
{prepared-body}
EOF

gh pr create \
  --title "{plan-title}" \
  --body-file $ARTIFACTS_DIR/pr-body.md \
  --base $BASE_BRANCH
```

**If PR already exists**, update it:

```bash
gh pr edit {pr-number} --body-file $ARTIFACTS_DIR/pr-body.md
```

### 3.3 review 준비 상태 확인

If PR was created as draft, mark ready:

```bash
gh pr ready {pr-number} 2>/dev/null || true
```

### 3.4 PR 정보 저장

```bash
gh pr view --json number,url,headRefName,baseRefName
```

### 3.5 PR 번호 registry 작성

Write PR number for downstream review steps:

```bash
PR_NUMBER=$(gh pr view --json number -q '.number')
PR_URL=$(gh pr view --json url -q '.url')
echo "$PR_NUMBER" > $ARTIFACTS_DIR/.pr-number
echo "$PR_URL" > $ARTIFACTS_DIR/.pr-url
```

**PHASE_3_CHECKPOINT:**

- [ ] PR created or updated
- [ ] PR body uses template (if available)
- [ ] PR ready for review
- [ ] PR URL captured
- [ ] PR number registry written

---

## 4단계: Artifact — PR ready 상태 작성

### 4.1 최종 artifact 작성

Write to `$ARTIFACTS_DIR/pr-ready.md`:

```markdown
# PR Ready for Review

**Generated**: {YYYY-MM-DD HH:MM}
**Workflow ID**: $WORKFLOW_ID

---

## Pull Request

| Field | Value |
|-------|-------|
| **Number** | #{number} |
| **URL** | {url} |
| **Branch** | `{head}` → `{base}` |
| **Status** | Ready for Review |

---

## Commit

**Hash**: {commit-sha}
**Message**: {commit-message-first-line}

---

## Files in PR

{From git diff --name-only origin/$BASE_BRANCH}

| File | Status |
|------|--------|
| `src/x.ts` | Added |
| `src/y.ts` | Modified |

---

## PR Description

{Whether template was used or default format}

- Template used: {yes/no}
- Template path: {path if used}

---

## Next Step

Continue to PR review workflow:
1. `archon-pr-review-scope`
2. `archon-sync-pr-with-main`
3. Review agents (parallel)
4. `archon-synthesize-review`
5. `archon-implement-review-fixes`
```

**PHASE_4_CHECKPOINT:**

- [ ] PR ready artifact written

---

## 5단계: 출력 — 상태 보고

```markdown
## PR Ready for Review ✅

**Workflow ID**: `$WORKFLOW_ID`

### Pull Request

| Field | Value |
|-------|-------|
| PR | #{number} |
| URL | {url} |
| Branch | `{branch}` → `{base}` |
| Status | 🟢 Ready for Review |

### Commit

```
{commit-sha-short} {commit-message-first-line}
```

### Files Changed

- {N} files added
- {M} files modified
- {K} files deleted

### Validation Summary

| Check | Status |
|-------|--------|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ ({N} passed) |
| Build | ✅ |

### Artifact

Status written to: `$ARTIFACTS_DIR/pr-ready.md`

### Next Step

Proceeding to comprehensive PR review.
```

---

## 오류 처리

### Commit할 변경 없음

If no changes to commit:

```markdown
ℹ️ No changes to commit

All changes were already committed. Proceeding to update PR description.
```

### Push 실패

```bash
# Try force push if branch was rebased
git push --force-with-lease origin HEAD
```

If still fails:
```
❌ Push failed

Check:
1. Branch protection rules
2. Push access to repository
3. Remote branch status: `git fetch origin && git status`
```

### PR을 찾을 수 없음

```
❌ PR not found: #{number}

The draft PR may have been closed or deleted. Create a new one:
`gh pr create --title "..." --body "..."`
```

### Template parsing

If template has complex structure that's hard to fill:
- Use as much of the template as possible
- Add implementation details in relevant sections
- Note at bottom: "Some template sections may need manual completion"

---

## 성공 기준

- **CHANGES_COMMITTED**: All changes in a commit
- **PUSHED**: Branch pushed to remote
- **PR_UPDATED**: PR description reflects implementation
- **PR_READY**: Draft status removed
- **ARTIFACT_WRITTEN**: PR ready artifact created
