---
description: code review findings를 PR comment로 게시
argument-hint: (none - reads from artifacts)
---

# PR에 리뷰 게시

---

## 미션

Read the code review findings artifact and post a formatted summary as a comment on the PR.

---

## 1단계: 로드 — 컨텍스트 수집

### 1.1 가져오기 PR 번호

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

**If not found:**
```
❌ No PR number found at $ARTIFACTS_DIR/.pr-number
Cannot post review without a PR number.
```

### 1.2 읽기 review findings

```bash
cat $ARTIFACTS_DIR/review/code-review-findings.md
```

**If not found:**
```
❌ No review findings found at $ARTIFACTS_DIR/review/code-review-findings.md
Run code review first.
```

**PHASE_1_CHECKPOINT:**
- [ ] PR number loaded
- [ ] Review findings loaded

---

## 2단계: 형식화 — PR comment 작성

### 2.1 핵심 정보 추출

From the review findings, extract:
- **Verdict**: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION
- **Summary**: 2-3 sentence overview
- **Findings**: All findings with severity and location
- **Statistics**: Finding counts by severity

### 2.2 comment body 작성

Format the review as a GitHub-friendly comment:

```markdown
## 🔍 Code Review

**Verdict**: {APPROVE ✅ | REQUEST_CHANGES ❌ | NEEDS_DISCUSSION 💬}

{Summary from findings}

---

### Findings

{For each finding:}

#### {severity emoji} {title}

**Severity**: {CRITICAL|HIGH|MEDIUM|LOW} · **Category**: {category} · **Location**: `{file}:{line}`

{Issue description}

<details>
<summary>Suggested Fix</summary>

```typescript
{recommended fix code}
```

**Why**: {reasoning}

</details>

---

{End of findings}

### Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | {n} |
| 🟠 High | {n} |
| 🟡 Medium | {n} |
| 🔵 Low | {n} |

{If positive observations exist:}

### What's Done Well

{Positive observations from review}

---

*Automated code review*
```

**Severity emojis:**
- CRITICAL → 🔴
- HIGH → 🟠
- MEDIUM → 🟡
- LOW → 🔵

**PHASE_2_CHECKPOINT:**
- [ ] Comment body formatted
- [ ] All findings included
- [ ] Statistics table present

---

## 3단계: 게시 — PR에 comment

### 3.1 comment 게시

```bash
gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
{formatted comment body}
EOF
)"
```

### 3.2 확인

```bash
# Check the comment was posted
gh pr view {PR_NUMBER} --comments --json comments --jq '.comments | length'
```

**PHASE_3_CHECKPOINT:**
- [ ] Comment posted to PR
- [ ] Verified comment exists

---

## 4단계: 출력 — 사용자에게 보고

```markdown
## Review Posted to PR

**PR**: #{PR_NUMBER}
**Verdict**: {verdict}
**Findings**: {total count} ({critical} critical, {high} high, {medium} medium, {low} low)

Review comment has been posted to the pull request.
```

---

## 오류 처리

### PR을 찾을 수 없음
- Verify PR number is correct
- Check if PR is still open
- Report error to user

### Comment 게시 실패
- Check GitHub authentication
- Try with shorter body if too large
- Report error with details

### Findings 없음
- Post a clean review comment: "No issues found. LGTM!"

---

## 성공 기준

- **FINDINGS_LOADED**: Review artifact read successfully
- **COMMENT_FORMATTED**: PR comment built with all findings
- **COMMENT_POSTED**: Comment visible on the PR
