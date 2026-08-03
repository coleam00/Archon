#!/bin/bash
# SessionStart hook: verify the restored task list exists and is accessible.
# Installed by /save-task-list skill into .claude/settings.local.json.
#
# Input: JSON on stdin with session_id, hook_event_name, etc.
# Output: JSON with systemMessage (shown to user) or additionalContext.

INPUT=$(cat)
TASK_LIST_ID="${CLAUDE_CODE_TASK_LIST_ID:-}"

# No task list requested — nothing to do
if [ -z "$TASK_LIST_ID" ]; then
  exit 0
fi

TASK_DIR="$HOME/.claude/tasks/$TASK_LIST_ID"

if [ -d "$TASK_DIR" ]; then
  TASK_COUNT=$(find "$TASK_DIR" -name '*.json' -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
  # Surface confirmation to the user
  jq -n --arg id "$TASK_LIST_ID" --arg count "$TASK_COUNT" '{
    "systemMessage": ("Task list " + $id + " restored (" + $count + " tasks). Use TaskList to review.")
  }'
else
  # Warn the user — the task list directory is missing
  jq -n --arg id "$TASK_LIST_ID" --arg dir "$TASK_DIR" '{
    "systemMessage": ("Warning: Task list " + $id + " not found at " + $dir + ". It may have been cleaned up.")
  }'
fi

exit 0
