---
title: Per-Node Hooks
description: Attach Claude Agent SDK hooks to individual workflow nodes for tool control, context injection, and input modification.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 6
---

DAG workflow nodes support a `hooks` field that attaches Claude Agent SDK hooks
to individual nodes. Hooks fire during the node's AI execution and can control
tool behavior, inject context, modify inputs, and more.

**Claude only** — Codex nodes will warn and ignore hooks.

## Quick Start

```yaml
name: safe-migration
description: Generate SQL with guardrails
nodes:
  - id: generate
    prompt: "Generate a database migration for $ARGUMENTS"
    hooks:
      PreToolUse:
        - matcher: "Bash"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "No shell access during SQL generation"
```

## How It Works

Each hook matcher has three fields:
- `matcher` (optional): Regex pattern to filter by tool name. Omit to match all tools.
- `response` (required): The SDK `SyncHookJSONOutput` returned when the hook fires.
- `timeout` (optional): Seconds before the hook times out (default: 60).

At runtime, each YAML hook is wrapped in a trivial callback:
```
async () => response
```
No custom DSL — `response` IS the SDK type, passed through unchanged.

**Important**: When using `hookSpecificOutput`, you must include a `hookEventName`
field that matches the event key (e.g., `hookEventName: PreToolUse` inside a
`PreToolUse` hook). This is an SDK requirement — it uses this field to determine
which event-specific fields to process.

## Supported Hook Events

| Event | Fires When | Matcher Filters On |
|-------|-----------|-------------------|
| `PreToolUse` | Before a tool executes | Tool name (e.g. `Bash`, `Write`, `Read`) |
| `PostToolUse` | After a tool succeeds | Tool name |
| `PostToolUseFailure` | After a tool fails | Tool name |
| `Notification` | System notification | Notification type |
| `Stop` | Agent stops | N/A |
| `SubagentStart` | Subagent spawned | Agent type |
| `SubagentStop` | Subagent finishes | Agent type |
| `PreCompact` | Before context compaction | Trigger (`manual`/`auto`) |
| `SessionStart` | Session begins | Source (`startup`/`resume`/`clear`/`compact`) |
| `SessionEnd` | Session ends | Exit reason |
| `UserPromptSubmit` | User prompt submitted | N/A |
| `PermissionRequest` | Permission prompt would appear | Tool name |
| `Setup` | SDK initialization | Trigger (`init`/`maintenance`) |
| `TeammateIdle` | Agent teammate goes idle | N/A |
| `TaskCompleted` | Background task finishes | N/A |
| `Elicitation` | MCP server requests user input | N/A |
| `ElicitationResult` | Elicitation response received | N/A |
| `ConfigChange` | Settings/config file changed | Source (`user_settings`/`project_settings`/etc.) |
| `WorktreeCreate` | Git worktree created | Worktree name |
| `WorktreeRemove` | Git worktree removed | Worktree path |
| `InstructionsLoaded` | CLAUDE.md/instructions loaded | Memory type (`User`/`Project`/`Local`/`Managed`) |

Tool names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`,
`Agent`, plus MCP tools as `mcp__<server>__<action>`.

## Response Format (SDK `SyncHookJSONOutput`)

The `response` object supports these fields:

| Field | Type | Effect |
|-------|------|--------|
| `hookSpecificOutput` | object | Event-specific response (see below) |
| `systemMessage` | string | Inject a message visible to the model |
| `continue` | boolean | `false` stops the agent |
| `decision` | `'approve'` / `'block'` | Top-level approve/block |
| `stopReason` | string | Reason when stopping |
| `suppressOutput` | boolean | Suppress output emission |

### PreToolUse `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: PreToolUse
  permissionDecision: deny | allow | ask  # Control whether tool runs
  permissionDecisionReason: "..."         # Why (shown in logs)
  updatedInput:                           # Modify tool arguments
    file_path: "/sandbox/output.ts"
  additionalContext: "..."                # Text injected into model context
```

### PostToolUse `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: PostToolUse
  additionalContext: "..."         # Text injected after tool result
  updatedMCPToolOutput: ...        # Override what model sees from tool
```

### PostToolUseFailure `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: PostToolUseFailure
  additionalContext: "..."         # Context after tool failure
```

### Elicitation `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: Elicitation
  action: accept | decline | cancel  # Respond to MCP elicitation
  content: { ... }                   # Form field values
```

### ElicitationResult `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: ElicitationResult
  action: accept | decline | cancel  # Override elicitation result
  content: { ... }                   # Modified response values
```

## Examples

### Deny a tool entirely

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "Shell access not allowed in this node"
```

### Deny tools with a reason message

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "Only read operations are allowed — do not modify files"
```

### Inject context before tool use (without blocking)

Note: this does NOT block the tool — it adds guidance the model sees before the tool runs.

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          additionalContext: "Only write to files in the src/ directory"
```

### Redirect file writes (modify tool input)

```yaml
hooks:
  PreToolUse:
    - matcher: "Write"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: allow
          updatedInput:
            file_path: "/sandbox/output.ts"
```

### Inject steering instructions after every tool call

```yaml
hooks:
  PostToolUse:
    - response:
        systemMessage: "Check: is this output relevant to the task? If not, stop and explain why."
```

### Inject context after reading files

```yaml
hooks:
  PostToolUse:
    - matcher: "Read"
      response:
        hookSpecificOutput:
          hookEventName: PostToolUse
          additionalContext: "You just read a file. Do NOT modify it — analysis only."
```

### Emergency stop on shell access

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        continue: false
        stopReason: "Emergency halt — shell access attempted"
```

### Multiple hooks on one node

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "No shell"
    - matcher: "Write|Edit"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          additionalContext: "Only write to files in src/"
  PostToolUse:
    - response:
        systemMessage: "Verify output before continuing"
```

### Full workflow example

```yaml
name: safe-code-review
description: Review code with guardrails
nodes:
  - id: fetch-diff
    bash: "git diff main...HEAD"

  - id: review
    prompt: "Review this diff for bugs and security issues: $fetch-diff.output"
    depends_on: [fetch-diff]
    hooks:
      PreToolUse:
        - matcher: "Bash"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "Code review should not execute commands"
        - matcher: "Write|Edit"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "Code review is read-only"
      PostToolUse:
        - matcher: "Read"
          response:
            hookSpecificOutput:
              hookEventName: PostToolUse
              additionalContext: "Focus on security issues in this file"

  - id: summarize
    prompt: "Summarize the review findings from $review.output"
    depends_on: [review]
    allowed_tools: []
```

## Hooks vs allowed_tools/denied_tools

| Feature | `allowed_tools`/`denied_tools` | `hooks` |
|---------|-------------------------------|---------|
| Block a tool entirely | Yes | Yes |
| Inject context | No | Yes (`additionalContext`, `systemMessage`) |
| Modify tool input | No | Yes (`updatedInput`) |
| Override tool output | No | Yes (`updatedMCPToolOutput`) |
| Stop the agent | No | Yes (`continue: false`) |
| React after tool use | No | Yes (`PostToolUse`) |

Use `allowed_tools`/`denied_tools` for simple include/exclude. Use `hooks` when you
need context injection, input modification, or post-tool-use reactions.

## Limitations

- **Static responses only in YAML** — hooks return the same response every time.
  For conditional logic, use `when:` conditions on downstream nodes or gate execution with upstream bash nodes that emit structured output.
- **Claude only** — Codex nodes warn and ignore hooks.
- **No hook event streaming** — hook lifecycle events (`hook_started`, `hook_progress`)
  are not forwarded to the Web UI.

## SDK Reference

Refer to the [Anthropic Claude Agent SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk) for the authoritative `SyncHookJSONOutput` type, hook event reference, and matcher patterns.

## Related

- [Per-Node MCP Servers](/guides/mcp-servers/) — `mcp:` field for external tool access
- [Per-Node Skills](/guides/skills/) — `skills:` field for domain knowledge injection
