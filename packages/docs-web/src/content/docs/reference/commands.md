---
title: Commands Reference
description: All slash commands available in Archon adapters including Web UI, Telegram, Slack, Discord, and GitHub.
category: reference
area: handlers
audience: [user]
status: current
sidebar:
  order: 4
---

All slash commands available in Archon. Type `/help` in any platform adapter (Web UI, Telegram, Slack, Discord, GitHub) to see this list.

---

## Deterministic Commands

These commands are handled deterministically by the orchestrator — they always execute the same way regardless of AI state:

## Project Management

| Command | Description |
|---------|-------------|
| `/register-project <path>` | Register a local directory as a project |
| `/update-project <name> <path>` | Update a project's directory path |
| `/remove-project <name>` | Remove a project registration |

## Workflows

| Command | Description |
|---------|-------------|
| `/workflow list` | Show available workflows |
| `/workflow reload` | Reload workflow definitions |
| `/workflow status` | Show active workflows |
| `/workflow cancel` | Cancel running workflow |
| `/workflow resume <id>` | Resume a failed run (re-runs, skipping completed nodes) |
| `/workflow abandon <id>` | Discard a non-terminal run |
| `/workflow approve <id> [comment]` | Approve a paused workflow run at an approval gate |
| `/workflow reject <id> [reason]` | Reject a paused workflow run at an approval gate |
| `/workflow run <name> [args]` | Run a workflow directly |
| `/workflow cleanup [days]` | CLI only -- delete old run records (default: 7 days) |

> **Note:** Workflows are YAML files in `.archon/workflows/`

## Session Management

| Command | Description |
|---------|-------------|
| `/status` | Show conversation state |
| `/reset` | Clear session completely |
| `/help` | Show all commands |

---

## AI-Routed Commands

The following commands exist in the command handler but are **not** deterministically routed. Instead, they are routed through the AI orchestrator, which decides whether to invoke them based on context. They work when the AI routes a message to them:

| Command | Description |
|---------|-------------|
| `/clone <repo-url>` | Clone repository |
| `/repos` | List repositories (numbered) |
| `/repo <#\|name> [pull]` | Switch repo (auto-loads commands) |
| `/repo-remove <#\|name>` | Remove repo and codebase record |
| `/getcwd` | Show working directory |
| `/setcwd <path>` | Set working directory |
| `/command-set <name> <path> [text]` | Register a command from file |
| `/load-commands <folder>` | Bulk load commands (recursive) |
| `/commands` | List registered commands |
| `/worktree create <branch>` | Create isolated worktree |
| `/worktree list` | Show worktrees for this repo |
| `/worktree remove [--force]` | Remove current worktree |
| `/worktree cleanup merged\|stale` | Clean up worktrees |
| `/worktree orphans` | Show all worktrees from git |
| `/init` | Create `.archon` structure in current repo |
| `/reset-context` | Reset AI context, keep worktree |

> **Note:** In practice, you rarely need to type these commands directly. Describe what you want in natural language and the AI router will invoke the appropriate command or workflow.

---

## Example Workflow (Telegram)

### Ask Questions Directly

```
You: What's the structure of this repo?

Bot: [Claude analyzes and responds...]
```

### Check Status

```
You: /status

Bot: Platform: telegram
     AI Assistant: claude

     Codebase: my-project
     Repository: https://github.com/user/my-project

     Repository: my-project @ main

     Worktrees: 0/10
```

### Reset Session

```
You: /reset

Bot: Session cleared. Starting fresh on next message.

     Codebase configuration preserved.
```

---

## Example Workflow (GitHub)

Create an issue or comment on an existing issue/PR:

```
@your-bot-name can you help me understand the authentication flow?
```

Bot responds with analysis. Continue the conversation:

```
@your-bot-name can you create a sequence diagram for this?
```

Bot maintains context and provides the diagram.
