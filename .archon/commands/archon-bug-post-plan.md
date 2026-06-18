---
description: Post the current plan to JIRA with approval instructions
argument-hint: <jira-key>
---

# Post Plan to JIRA

Posts the current `$ARTIFACTS_DIR/plan.md` as a JIRA comment with the
`@bug-killer APPROVED` / `@bug-killer REVISE:` approval footer.

Run this verbatim:

```bash
set -euo pipefail

JIRA_KEY=$(cat "$ARTIFACTS_DIR/.jira-key")

if [ ! -s "$ARTIFACTS_DIR/plan.md" ]; then
  echo "FATAL: $ARTIFACTS_DIR/plan.md is missing or empty" >&2
  exit 1
fi

PLAN_TEXT=$(cat "$ARTIFACTS_DIR/plan.md")
FOOTER="

---
**Approval Required**

Reply with:
- \`@bug-killer APPROVED\` — to proceed with implementation
- \`@bug-killer REVISE: <feedback>\` — to request changes to the plan"

FULL_TEXT="$PLAN_TEXT$FOOTER"

ADF_BODY=$(jq -n --arg text "$FULL_TEXT" '{
  body: {
    version: 1,
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: {level: 2},
        content: [{type: "text", text: "📋 BugKiller Fix Plan — Approval Required"}]
      },
      {type: "rule"},
      {
        type: "paragraph",
        content: [{type: "text", text: $text}]
      }
    ]
  }
}')

HTTP_CODE=$(curl -s -o /tmp/jira-post-plan-resp.json -w "%{http_code}" -X POST \
  -u "$JIRA_USER:$JIRA_API_TOKEN" \
  "$JIRA_BASE_URL/rest/api/3/issue/$JIRA_KEY/comment" \
  -H "Content-Type: application/json" \
  -d "$ADF_BODY")

if [ "$HTTP_CODE" -ge 400 ]; then
  echo "FATAL: JIRA comment POST returned HTTP $HTTP_CODE" >&2
  cat /tmp/jira-post-plan-resp.json >&2
  exit 1
fi

echo "Posted plan to $JIRA_KEY (HTTP $HTTP_CODE)"
```
