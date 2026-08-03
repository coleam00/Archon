#!/bin/bash
# Stop hook: notify Slack with a summary of the rulecheck run.
# Extracts info from the stop event JSON (last_assistant_message) since
# the summary file may not exist yet when this hook fires.
#
# Input: JSON on stdin with stop event context
# Output: exit 0 always (notification failure should not block the agent)
#
# Uses SLACK_WEBHOOK_URL env var if set, otherwise falls back to hardcoded URL.

INPUT=$(cat)

if [ -z "$SLACK_WEBHOOK_URL" ]; then
  # No webhook configured — skip notification silently
  exit 0
fi

# Extract the last assistant message from the stop event
LAST_MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

if [ -z "$LAST_MESSAGE" ]; then
  LAST_MESSAGE="Rulecheck agent completed (no summary available)"
fi

# Try to extract a PR URL from the message
PR_URL=$(echo "$LAST_MESSAGE" | grep -oE 'https://github\.com/[^ ]+/pull/[0-9]+' | head -1)

if [ -n "$PR_URL" ]; then
  PR_LINE="*PR*: <${PR_URL}|View Pull Request>"
else
  PR_LINE="*PR*: No PR created"
fi

# Truncate message for Slack (max 3000 chars in a section)
SUMMARY=$(echo "$LAST_MESSAGE" | head -20 | cut -c1-2000)

PAYLOAD=$(jq -n \
  --arg pr "$PR_LINE" \
  --arg summary "$SUMMARY" \
  '{
    "blocks": [
      {
        "type": "header",
        "text": { "type": "plain_text", "text": "Rulecheck Agent Run Complete" }
      },
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": $pr }
      },
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": $summary }
      }
    ]
  }')

# Send to Slack — don't let curl failure block the agent
curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true

exit 0
