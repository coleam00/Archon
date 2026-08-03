#!/bin/bash
# PreToolUse hook: block dangerous commands from the rulecheck agent.
# Prevents force pushes, hard resets, git clean, and destructive rm operations.
#
# Input: JSON on stdin with tool_input.command
# Output: exit 0 to allow, exit 2 + stderr message to block.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# No command found — not a Bash tool call, allow
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Block git push --force / -f
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(-f|--force)'; then
  echo "Blocked: force push is not allowed. Push normally or ask the user." >&2
  exit 2
fi

# Block git clean -fd (explicit CLAUDE.md rule)
if echo "$COMMAND" | grep -qE 'git\s+clean'; then
  echo "Blocked: git clean permanently deletes untracked files. Use 'git checkout .' instead." >&2
  exit 2
fi

# Block git reset --hard
if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
  echo "Blocked: git reset --hard discards all changes. Use a safer alternative." >&2
  exit 2
fi

# Block rm -rf outside worktree (allow rm -rf within .claude/ or node_modules)
if echo "$COMMAND" | grep -qE 'rm\s+-rf?\s+/' | grep -vqE '(node_modules|\.claude/)'; then
  echo "Blocked: rm -rf with absolute paths is not allowed from this agent." >&2
  exit 2
fi

# Block destructive operations targeting main/master
if echo "$COMMAND" | grep -qE 'git\s+(push|branch\s+-[dD]|checkout)\s+.*(main|master)'; then
  echo "Blocked: destructive operations on main/master are not allowed." >&2
  exit 2
fi

exit 0
