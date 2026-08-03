---
description: Post code review findings as a comment on the PR
argument-hint: (none - reads from artifacts)
---

# Post Review to PR

---

## Your Mission

Read the code review findings artifact and post a formatted summary as a comment on the PR.

---

## Phase 1: LOAD - Get Context

### 1.1 Get PR Number

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
```

**If not found:**
```
❌ No PR number found at $ARTIFACTS_DIR/.pr-number
Cannot post review without a PR number.
```

### 1.2 Read Review Findings

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

## Phase 2: FORMAT - Build PR Comment

### 2.1 Extract Key Information

From the review findings, extract:
- **Verdict**: APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION
- **Summary**: 2-3 sentence overview
- **Findings**: All findings with severity and location
- **Statistics**: Finding counts by severity

### 2.2 Build Comment Body

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

## Phase 3: POST - Comment on PR

### 3.1 Post the Comment

```bash
gh pr comment {PR_NUMBER} --body "$(cat <<'EOF'
{formatted comment body}
EOF
)"
```

### 3.2 Verify

```bash
# Check the comment was posted
gh pr view {PR_NUMBER} --comments --json comments --jq '.comments | length'
```

**PHASE_3_CHECKPOINT:**
- [ ] Comment posted to PR
- [ ] Verified comment exists

---

## Phase 4: OUTPUT - Report to User

```markdown
## Review Posted to PR

**PR**: #{PR_NUMBER}
**Verdict**: {verdict}
**Findings**: {total count} ({critical} critical, {high} high, {medium} medium, {low} low)

Review comment has been posted to the pull request.
```

---

## Error Handling

### PR not found
- Verify PR number is correct
- Check if PR is still open
- Report error to user

### Comment fails to post
- Check GitHub authentication
- Try with shorter body if too large
- Report error with details

### No findings
- Post a clean review comment: "No issues found. LGTM!"

---

## Success Criteria

- **FINDINGS_LOADED**: Review artifact read successfully
- **COMMENT_FORMATTED**: PR comment built with all findings
- **COMMENT_POSTED**: Comment visible on the PR
