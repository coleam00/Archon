---
description: Post completion report to JIRA ticket with results, unaddressed items, and follow-up suggestions
argument-hint: (none - reads from workflow artifacts)
---

# JIRA Issue Completion Report

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Compile all workflow artifacts into a final report and post it to the original JIRA ticket.
Summarize what was done, what wasn't addressed (and why), and suggest follow-up tickets if needed.

**JIRA action**: Post completion report as a comment on the JIRA ticket
**Output artifact**: `$ARTIFACTS_DIR/completion-report.md`

---

## Phase 1: LOAD — Gather All Artifacts

### 1.1 Get JIRA Key and PR Info

```bash
JIRA_KEY=$(cat "$ARTIFACTS_DIR/.jira-key")
JIRA_URL="$JIRA_BASE_URL/browse/$JIRA_KEY"

PR_NUMBER=$(cat "$ARTIFACTS_DIR/.pr-number" 2>/dev/null || echo "unknown")
PR_URL=$(cat "$ARTIFACTS_DIR/.pr-url" 2>/dev/null || echo "unknown")

echo "JIRA: $JIRA_URL"
echo "PR: $PR_NUMBER ($PR_URL)"
```

### 1.2 Read All Available Artifacts

```bash
cat "$ARTIFACTS_DIR/investigation.md" 2>/dev/null
cat "$ARTIFACTS_DIR/implementation.md" 2>/dev/null
cat "$ARTIFACTS_DIR/web-research.md" 2>/dev/null
cat "$ARTIFACTS_DIR/validation.md" 2>/dev/null
ls "$ARTIFACTS_DIR/review/" 2>/dev/null
cat "$ARTIFACTS_DIR/review/consolidated-review.md" 2>/dev/null
cat "$ARTIFACTS_DIR/review/fix-report.md" 2>/dev/null
```

### 1.3 Get Git Info

```bash
git branch --show-current
git log --oneline -5
```

**PHASE_1_CHECKPOINT:**
- [ ] JIRA key and URL captured
- [ ] PR info loaded
- [ ] All available artifacts read
- [ ] Git state captured

---

## Phase 2: COMPILE — Build Report

### 2.1 Summarize What Was Done

From the artifacts, compile:

- **Root Cause**: Key findings and approach
- **Implementation**: What was changed, files modified
- **Validation**: Test results, lint, type-check
- **Review**: What was reviewed, findings count
- **Self-fix**: What review findings were fixed

### 2.2 Identify Unaddressed Items

From the fix report and consolidated review:

- Findings that were SKIPPED (with reasons)
- Findings that were BLOCKED (with reasons)
- MEDIUM/LOW findings not auto-fixed
- Any validation issues that persisted

### 2.3 Suggest Follow-up Tickets

For each unaddressed item, determine if it warrants a follow-up JIRA ticket:

| Item | Warrants Ticket? | Why |
|------|-----------------|-----|
| {skipped finding} | YES/NO | {reason} |

**PHASE_2_CHECKPOINT:**
- [ ] Summary compiled
- [ ] Unaddressed items identified
- [ ] Follow-up suggestions prepared

---

## Phase 3: GENERATE — Write Artifact

Write the markdown completion report to `$ARTIFACTS_DIR/completion-report.md`:

```markdown
# Completion Report: {JIRA_KEY}

**Date**: {ISO timestamp}
**Workflow ID**: $WORKFLOW_ID
**JIRA**: [{JIRA_KEY}]({JIRA_URL})
**PR**: #{PR_NUMBER} ({PR_URL})

---

## Summary

{3–5 sentence overview of the entire workflow execution}

---

## Root Cause

{Brief summary of what caused the bug and how it was fixed}

---

## Implementation

| File | Action | Description |
|------|--------|-------------|
| `{file}` | {CREATE/UPDATE} | {what changed} |

---

## Validation

| Check | Result |
|-------|--------|
| Type check | ✅ / ❌ |
| Lint | ✅ / ❌ |
| Tests | ✅ ({n} passed) / ❌ |

---

## Review & Self-Fix

- **Findings**: {n} total from review agents
- **Fixed**: {n} (including tests, docs, simplification)
- **Skipped**: {n}
- **Blocked**: {n}

---

## Unaddressed Items

{If none: "All findings were addressed."}

| Finding | Severity | Reason |
|---------|----------|--------|
| {title} | {sev} | {why not addressed} |

---

## Suggested Follow-up Tickets

| Title | Priority | Description |
|-------|----------|-------------|
| "{title}" | {P1/P2/P3} | {brief description} |

*(none)* if everything was addressed
```

**PHASE_3_CHECKPOINT:**
- [ ] Completion report written to `$ARTIFACTS_DIR/completion-report.md`

---

## Phase 4: POST — JIRA Comment (ADF)

Build and post the completion comment to the JIRA ticket using the Atlassian Document Format (ADF).

Read the completion report, then construct the ADF JSON and POST it:

```bash
JIRA_KEY=$(cat "$ARTIFACTS_DIR/.jira-key")
PR_NUMBER=$(cat "$ARTIFACTS_DIR/.pr-number" 2>/dev/null || echo "")
PR_URL=$(cat "$ARTIFACTS_DIR/.pr-url" 2>/dev/null || echo "")

# Build values from artifacts (fill these from your compiled report)
SUMMARY_TEXT="{3-5 sentence summary from Phase 2}"
ROOT_CAUSE_TEXT="{root cause one-liner}"
IMPL_TEXT="{comma-separated list of changed files and what changed}"
VALIDATION_TEXT="{type-check ✅ lint ✅ tests ✅ (N passed)}"
REVIEW_TEXT="{N findings, N fixed, N skipped}"
FOLLOWUP_TEXT="{follow-up suggestions or 'None — all findings addressed'}"
WORKFLOW_FOOTER="Fixed by Archon workflow $WORKFLOW_ID"

ADF_BODY=$(jq -n \
  --arg summary "$SUMMARY_TEXT" \
  --arg root_cause "$ROOT_CAUSE_TEXT" \
  --arg impl "$IMPL_TEXT" \
  --arg validation "$VALIDATION_TEXT" \
  --arg review "$REVIEW_TEXT" \
  --arg followup "$FOLLOWUP_TEXT" \
  --arg pr_label "PR #$PR_NUMBER" \
  --arg pr_url "$PR_URL" \
  --arg footer "$WORKFLOW_FOOTER" \
'{
  body: {
    version: 1,
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: {level: 2},
        content: [{type: "text", text: "✅ Bug Resolution Complete"}]
      },
      {
        type: "paragraph",
        content: [
          {type: "text", text: "PR: "},
          {type: "text", text: $pr_label, marks: [{type: "link", attrs: {href: $pr_url}}]},
          {type: "text", text: "  |  Status: COMPLETE"}
        ]
      },
      {type: "rule"},
      {
        type: "heading",
        attrs: {level: 3},
        content: [{type: "text", text: "Summary"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $summary}]
      },
      {
        type: "heading",
        attrs: {level: 3},
        content: [{type: "text", text: "Root Cause"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $root_cause}]
      },
      {
        type: "heading",
        attrs: {level: 3},
        content: [{type: "text", text: "Changes Made"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $impl}]
      },
      {
        type: "heading",
        attrs: {level: 3},
        content: [{type: "text", text: "Validation"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $validation}]
      },
      {
        type: "heading",
        attrs: {level: 3},
        content: [{type: "text", text: "Review & Self-Fix"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $review}]
      },
      {
        type: "heading",
        attrs: {level: 3},
        content: [{type: "text", text: "Suggested Follow-up"}]
      },
      {
        type: "paragraph",
        content: [{type: "text", text: $followup}]
      },
      {type: "rule"},
      {
        type: "paragraph",
        content: [{type: "text", text: $footer, marks: [{type: "em"}]}]
      }
    ]
  }
}')

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -u "$JIRA_USER:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$JIRA_KEY/comment" \
  -H "Content-Type: application/json" \
  -d "$ADF_BODY")

if [ "$HTTP_CODE" = "201" ]; then
  echo "Completion report posted to $JIRA_KEY (HTTP 201)"
else
  echo "JIRA comment POST returned HTTP $HTTP_CODE — check credentials and ADF structure" >&2
fi
```

**PHASE_4_CHECKPOINT:**
- [ ] ADF comment posted to JIRA ticket (HTTP 201)

---

## Phase 5: OUTPUT — Final Summary

```markdown
## JIRA Resolution Complete

**Ticket**: {JIRA_KEY} — {summary}
**JIRA URL**: {JIRA_URL}
**PR**: #{PR_NUMBER} ({PR_URL})
**Workflow**: $WORKFLOW_ID

### Results

- Root cause investigation: ✅
- Implementation: ✅
- Validation: ✅
- Review: ✅
- Self-fix: ✅

### Unaddressed: {n} items
### Follow-up tickets suggested: {n}

### Artifacts

- Completion report: `$ARTIFACTS_DIR/completion-report.md`
- JIRA comment: Posted to {JIRA_KEY}

### Next Steps

1. Review the PR: #{PR_NUMBER} ({PR_URL})
2. Create suggested follow-up JIRA tickets if agreed
3. Merge when ready — JIRA status will update automatically on merge if Jira-GitHub integration is configured
```

---

## Success Criteria

- **ALL_ARTIFACTS_READ**: All workflow artifacts loaded and parsed
- **REPORT_COMPILED**: Comprehensive completion report written to `$ARTIFACTS_DIR/completion-report.md`
- **JIRA_POSTED**: ADF comment visible on JIRA ticket (HTTP 201)
- **UNADDRESSED_DOCUMENTED**: Clear reasons for anything not fixed
- **FOLLOWUPS_SUGGESTED**: Actionable follow-up tickets recommended where appropriate
