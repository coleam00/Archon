---
name: save-task-list
description: Save current task list for reuse across sessions
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: |
            A skill just finished saving a task list for session reuse.
            Evaluate the assistant's final message below.

            $ARGUMENTS

            Verify:
            1. A task list ID was found and displayed
            2. A startup command (CODEX_TASK_LIST_ID=<id> codex) was provided
            3. A task summary was shown

            Return {"ok": true} if all three are present.
            Return {"ok": false, "reason": "Missing: <what>"} if anything is missing.
          statusMessage: "Verifying task list was saved..."
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "jq -r '[.tool_name, .tool_input.command // \"n/a\"] | join(\": \")' | head -1"
          statusMessage: "Logging tool use..."
          once: true
---

# Save Task List for Reuse

Save the current session's task list so it can be restored in future sessions.

## Session Context

- **Session ID**: ${CODEX_SESSION_ID}
- **Active task directories**: !`ls -1t ~/.codex/tasks/ 2>/dev/null | head -5 || echo "none found"`
- **Current tasks in session**: !`ls -1t ~/.codex/tasks/ 2>/dev/null | head -1 | xargs -I{} ls ~/.codex/tasks/{} 2>/dev/null | head -10 || echo "no tasks"`

---

## Instructions

1. **Find the current task list ID** by checking `~/.codex/tasks/` for the most
   recently modified directory. List the directories sorted by modification time.

2. **Verify the match** - read the task files inside the directory and compare
   them to any tasks you know about from this session. Confirm you have the
   correct task list.

3. **Log the session mapping** - write the mapping to `.archon/sessions/`:

   ```bash
   mkdir -p .archon/sessions
   echo '{"session": "${CODEX_SESSION_ID}", "task_list": "<TASK_LIST_ID>", "saved_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' \
     >> .archon/sessions/task-lists.jsonl
   ```

4. **Verify the SessionStart hook is installed** - the project-level
   `.archon/settings.json` already includes a SessionStart hook that runs
   `verify-task-list.sh` on every session start. Confirm it's present by
   reading the file. If it's missing for some reason, add it back:

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "hooks": [
             {
               "type": "command",
               "command": ".archon/skills/save-task-list/hooks/verify-task-list.sh",
               "statusMessage": "Checking for restored task list..."
             }
           ]
         }
       ]
     }
   }
   ```

   **Important**: Merge - don't overwrite existing settings. If `hooks` or `SessionStart`
   already exists, append to the array. If the hook is already installed, skip this step.

5. **Output the startup command** for the user:

   ```
   To continue with this task list in a new session:

   CODEX_TASK_LIST_ID=<task_list_id> codex
   ```

   Explain: On startup, the SessionStart hook will verify the task list exists
   and show a confirmation message.

6. **Show the current task summary** so the user knows what's preserved
   (task subjects, statuses, and any dependencies).
