---
title: Hooks and Quality Loops
description: Intercept tool calls during node execution to inject guidance, block actions, or create feedback loops.
category: book
part: advanced
audience: [user]
sidebar:
  order: 9
---

In [Chapter 8](/book/dag-workflows/) you learned to route work through a graph — classify, branch, parallelize. But routing only controls *which* nodes run and in *what order*. Once a node is running, the AI is on its own: it reads files, writes code, runs commands, and you see the results after the fact.

**Hooks** change that. A hook intercepts tool calls *while a node is executing* — before or after — and lets you inject guidance, block actions, or create feedback loops. You're not rewriting the prompt; you're standing next to the AI as it works and whispering corrections in real time.

> **Claude only** — hooks are a Claude Agent SDK feature. Codex nodes will warn and skip any hooks you define.

---

## What Hooks Do

Every time the AI uses a tool — `Read`, `Write`, `Edit`, `Bash`, or any MCP tool — hooks can fire. There are two moments to intercept:

- **PreToolUse**: Runs before the tool executes. You can allow it, deny it, modify its inputs, or inject context the model sees before proceeding.
- **PostToolUse**: Runs after the tool completes successfully. You can inject context the model sees as it processes the result.

Hooks are defined per-node in your workflow YAML. They only apply during that node's execution:

```yaml
nodes:
  - id: implement
    command: implement-changes
    hooks:
      PreToolUse:
        - matcher: "Write|Edit"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              additionalContext: "Only write to files in src/. Do not modify tests."
```

The `matcher` is a regex against the tool name. `Write|Edit` matches either. Omit the matcher to fire on every tool call.

---

## Hook Types

### PreToolUse

Runs before the tool. Supports three response styles:

**Inject context** — Add guidance the model sees before the tool runs. Doesn't block the tool:

```yaml
PreToolUse:
  - matcher: "Bash"
    response:
      hookSpecificOutput:
        hookEventName: PreToolUse
        additionalContext: "Before running any command, confirm it's read-only"
```

**Deny the tool** — Stop this tool call entirely:

```yaml
PreToolUse:
  - matcher: "Bash"
    response:
      hookSpecificOutput:
        hookEventName: PreToolUse
        permissionDecision: deny
        permissionDecisionReason: "Shell access not allowed in this node"
```

**Modify the input** — Redirect where the tool operates:

```yaml
PreToolUse:
  - matcher: "Write"
    response:
      hookSpecificOutput:
        hookEventName: PreToolUse
        permissionDecision: allow
        updatedInput:
          file_path: "/sandbox/output.ts"
```

### PostToolUse

Runs after a tool completes. Use it to add context the model sees as it processes the result:

```yaml
PostToolUse:
  - matcher: "Read"
    response:
      hookSpecificOutput:
        hookEventName: PostToolUse
        additionalContext: "You just read this file. Do not modify it — analysis only."
```

### Matchers

The `matcher` field is a regex matched against tool names. Common patterns:

| Matcher | Matches |
|---------|---------|
| `"Write"` | The `Write` tool only |
| `"Write\|Edit"` | Either `Write` or `Edit` |
| `"Bash"` | The `Bash` tool |
| `"Read"` | The `Read` tool |
| *(omitted)* | Every tool call |

---

## Example: Self-Review Loop

Here's a pattern that creates quality pressure without changing your commands. After every file write or edit, the hook forces the model to see a reminder to re-read the result and verify it:

```yaml
name: implement-with-self-review
description: Implement changes with automatic post-write review prompts.

nodes:
  - id: implement
    command: implement-changes
    hooks:
      PostToolUse:
        - matcher: "Write|Edit"
          response:
            hookSpecificOutput:
              hookEventName: PostToolUse
              additionalContext: |
                You just modified a file. Before continuing:
                1. Re-read the file you just changed
                2. Run the type checker: bun run type-check
                3. If there are errors, fix them before proceeding

  - id: validate
    command: validate-changes
    depends_on: [implement]
```

Every time the `implement` node writes or edits a file, the model sees that reminder as part of the tool result. It doesn't guarantee the model complies — but it consistently applies quality pressure without you needing to encode it in the command itself.

This is what "quality loop" means: each write triggers a review prompt, which may trigger another write, which triggers another review. The loop runs inside a single node until the model is satisfied or the step completes.

---

## Example: Permission Denial

Some nodes shouldn't be allowed to do certain things. A PR creation node shouldn't modify code. A code review node shouldn't run shell commands or write files — it should read and report.

```yaml
name: safe-code-review
description: Review code without modifying it.

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
              permissionDecisionReason: "Code review is read-only — do not modify files"
```

The `review` node can read files to understand context, but it can't run commands or write anything. If it tries, the tool call is blocked and the model sees the reason. You've defined the node's operating envelope in the YAML, not buried in a prompt.

---

## Design Patterns

**Quality gates** — After writes, inject a reminder to verify correctness (type check, lint, re-read). Creates a self-correcting loop inside a single node.

**Guardrails** — Deny tools that shouldn't be used in this node. A planning node has no business running `Bash`. A summarization node has no business calling `Write`. Encode these constraints explicitly.

**Context injection** — Before a tool runs, inject relevant guidance. "You're about to read a migration file — note that column renames must be additive." The model sees this at the right moment, not buried at the top of a long prompt.

**Audit trail** — Use a `systemMessage` in `PostToolUse` to prompt the model to justify its action: "Explain what you just changed and why." The justification becomes part of the conversation history.

---

## Reference: Hook Schema

A hook entry has three fields:

| Field | Required | Description |
|-------|----------|-------------|
| `matcher` | No | Regex matched against tool name. Omit to match all tools. |
| `response` | Yes | The hook response object (see below). |
| `timeout` | No | Seconds before hook times out. Default: 60. |

The `response` object (top-level fields):

| Field | Type | Effect |
|-------|------|--------|
| `hookSpecificOutput` | object | Event-specific response (PreToolUse, PostToolUse, etc.) |
| `systemMessage` | string | Inject a message visible to the model |
| `continue` | boolean | `false` stops the agent entirely |
| `decision` | `'approve'` / `'block'` | Top-level approve/block |
| `stopReason` | string | Reason shown when stopping |

`PreToolUse` hook-specific output:

| Field | Effect |
|-------|--------|
| `hookEventName: PreToolUse` | Required — identifies the event type |
| `permissionDecision: deny\|allow\|ask` | Control whether the tool runs |
| `permissionDecisionReason` | Reason shown in logs and to the model |
| `additionalContext` | Text injected into model context (doesn't block) |
| `updatedInput` | Override tool arguments (e.g., redirect a file path) |

`PostToolUse` hook-specific output:

| Field | Effect |
|-------|--------|
| `hookEventName: PostToolUse` | Required |
| `additionalContext` | Text injected after the tool result |

> **Multiple hooks**: You can define multiple matchers under the same event. They all fire if their matcher matches. A node can have both `PreToolUse` and `PostToolUse` hooks active simultaneously.

> **Hooks vs `allowed_tools`**: Use `allowed_tools`/`denied_tools` for simple include/exclude. Use hooks when you need context injection, input modification, or reactions after a tool runs.

---

You now have the full toolkit: commands that define tasks, workflows that orchestrate them, DAG graphs that route conditionally, and hooks that steer behavior in real time.

[Chapter 10: Quick Reference →](/book/quick-reference/) collects every CLI command, variable, and YAML option in one scannable place.
