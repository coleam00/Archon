# Save Task List — Workshop Guide

## What This Skill Demonstrates

A simple command upgraded to a skill to showcase Claude Code extensibility features
across **two lifecycle phases**: during skill execution (skill-scoped hooks) and at
next session startup (settings-level SessionStart hook).

**Full demo steps**: See [part2-guide.md](../../workshop/part2-guide.md) — Feature 6.

## Features to Walk Through

### 1. Skill-Scoped Hooks (frontmatter `hooks:`)

**What are hooks?** Hooks are lifecycle interceptors that fire at specific points
during Claude Code's execution — before a tool runs (`PreToolUse`), after it
runs (`PostToolUse`), when Claude finishes responding (`Stop`), and 13 other
events. They can validate, log, modify, or block actions.

**Four handler types exist:**
- `type: "command"` — runs a shell script, reads JSON on stdin, blocks via exit code 2
- `type: "http"` — POSTs JSON to a URL, receives JSON back
- `type: "prompt"` — sends the event context to an LLM for a yes/no decision
- `type: "agent"` — spawns a subagent with Read/Grep/Glob to verify conditions

**Where hooks live determines their lifetime:**
- `settings.json` — active for the entire session
- Skill frontmatter — active only while the skill is running, cleaned up when it finishes
- Agent frontmatter — active only while the agent is running

**In this skill**, two hooks are defined in YAML frontmatter:

- **Stop hook** (`type: "prompt"`) — An LLM evaluates whether Claude actually
  completed the task before it stops. If the task list ID or startup command
  is missing, Claude is told to keep working. This is AI evaluating AI as a
  quality gate.
- **PostToolUse hook** (`type: "command"`) — Reads the tool call JSON from
  stdin via `jq` and logs it. Shows how command hooks receive structured JSON
  on stdin.

Both are **scoped to the skill** — they activate when `/save-task-list` is
invoked and clean up when it finishes. They don't affect other skills or the
main session.

### 2. `once: true`

**What is it?** A hook modifier that causes the hook to fire exactly once per
session, then automatically remove itself. Only available in skill-scoped hooks
(not agent frontmatter or settings).

**In this skill**: The PostToolUse hook has `once: true` — it fires on the first
Bash call, then removes itself. Useful for one-time setup, logging, or
initialization that shouldn't repeat.

### 3. `statusMessage`

**What is it?** A custom spinner text shown in the Claude Code UI while a hook
is executing. Replaces the generic "Running hook..." message so users know
what's happening.

**In this skill**: Both hooks have custom messages (`"Verifying task list was saved..."`,
`"Logging tool use..."`) — visible feedback during hook execution.

### 4. Dynamic Context Injection (`!`command``)

**What is it?** The backtick syntax (`!`command``) runs shell commands as
**preprocessing** before Claude sees the skill content. The command's stdout
replaces the placeholder inline. Claude receives real data, not instructions
to go find it. This is not tool use — it happens before the LLM is invoked.

**In this skill**: Two `!`command`` blocks inject live task state:

```
- !`ls -1t ~/.claude/tasks/ ...`    → injects task directory listing
- !`ls ... | head -1 | xargs ...`   → injects current task files
```

### 5. `${CLAUDE_SESSION_ID}`

**What is it?** A built-in variable that gets substituted with the current
Claude Code session identifier at runtime. Available in skill content alongside
`$ARGUMENTS` (user input) and `$N` (positional arguments).

**In this skill**: Used in the body text and in the JSONL log entry to correlate
task lists with sessions.

### 6. `disable-model-invocation: true`

**What is it?** A frontmatter field that controls who can invoke a skill. By
default, both the user (`/skill-name`) and Claude (automatically, based on the
description) can invoke skills. Setting `disable-model-invocation: true` means
only the user can trigger it — Claude never auto-invokes.

**Three invocation modes:**

| Frontmatter | User can invoke | Claude can invoke |
|---|---|---|
| (default) | Yes | Yes |
| `disable-model-invocation: true` | Yes | No |
| `user-invocable: false` | No | Yes |

**In this skill**: Saving task lists writes files (side effects), so only the
user should trigger it.

### 7. SessionStart Hook (settings-level, installed by the skill)

**What is it?** A hook defined in `settings.json` (not skill frontmatter) that
fires when a Claude Code session starts or resumes. SessionStart hooks run
before Claude processes any user input — they're used for environment setup,
validation, and context injection.

**Skill-scoped hooks can't fire at session start** — they only activate when the
skill is invoked. For hooks that must run at the beginning of every session,
you install them into `settings.json` or `settings.local.json`.

**In this skill**: The skill writes a SessionStart hook into
`.claude/settings.local.json` that checks if `CLAUDE_CODE_TASK_LIST_ID` is set,
verifies the task directory exists, and surfaces a confirmation (or warning) via
`systemMessage` JSON output.

**Key teaching moment**: This skill uses both lifetime models — skill-scoped
hooks during execution and settings-level hooks across sessions. The skill
installs its own infrastructure for future sessions.

## Live Demo Steps

### Part 1: Save the task list

1. **Show the SKILL.md** — walk through the frontmatter, then the body
2. **Create some tasks first** so there's something to save:
   ```
   Help me plan a refactor of the auth module. Break it into tasks.
   ```
3. **Invoke the skill**: `/save-task-list`
4. **Point out to the audience**:
   - The `statusMessage` spinner text appearing during hook execution
   - The startup command output (`CLAUDE_CODE_TASK_LIST_ID=<id> claude`)
   - The JSONL log written to `.claude/archon/sessions/task-lists.jsonl`
   - The SessionStart hook installed in `.claude/settings.local.json`
5. **Show the Stop hook in action** — if Claude tried to finish without showing
   the task list ID, the prompt hook would catch it and force Claude to complete

### Part 2: Restore in a new session

1. **Copy the startup command** from the output
2. **Start a new session**: `CLAUDE_CODE_TASK_LIST_ID=<id> claude`
3. **Point out**: The `statusMessage` spinner ("Checking for restored task list...")
   appears immediately, then the `systemMessage` confirmation shows the task count
4. **Run `TaskList`** to verify all tasks are accessible

## Comparison: Before vs After

| | Old Command | New Skill |
|---|---|---|
| Format | `.claude/commands/save-task-list.md` | `.claude/skills/save-task-list/SKILL.md` |
| Quality gates | None | Stop hook verifies output completeness |
| Observability | None | PostToolUse logs tool calls |
| Context | Static instructions | Dynamic `!`command`` injects live task state |
| Session tracking | None | `${CLAUDE_SESSION_ID}` in JSONL log |
| Invocation control | Anyone | `disable-model-invocation: true` |
| Session restore | Manual | SessionStart hook verifies task list on launch |

## Talking Points

- "Hooks in skill frontmatter are scoped — they only live while the skill runs. No global side effects."
- "The prompt hook is an LLM checking another LLM's work. That's the quality gate pattern."
- "`once: true` prevents the hook from firing repeatedly — useful for one-time setup or logging."
- "Dynamic context injection means Claude starts with real data, not instructions to go find it."
- "Skill-scoped hooks live during execution. Settings hooks live across sessions. This skill uses both."
- "The skill installs its own SessionStart hook — it's a self-configuring workflow."
