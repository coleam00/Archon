---
title: Claude Code Attention Plugin
description: View and answer Archon's attention queue from inside Claude Code using a live pane, a typed answer tool, and an optional automation skill.
category: guides
area: clients
audience: [user]
status: current
---

The `archon-attention` plugin brings Archon's attention queue into an interactive Claude Code session without modifying Archon's engine. It connects strictly through the documented CLI contracts (`archon workflow attention --all --json`, `--watch --protocol --json`, `respond`, and `answer --ref`).

## Requirements and Surface Notes

- **Claude Code CLI**: `>= v2.1.287` (tested on `v2.1.332`).
- **Archon CLI**: `archon` must be available on your `PATH`.
- **Where panes render**: interactive terminal sessions, Desktop Code tab, and VS Code chat panel (`>= v2.1.299`). Non-interactive `claude -p`, Agent SDK, WSL Desktop, and unsupported cloud sessions do not draw panes; running `/archon-attention` there prints a plain-text queue summary instead.

## Load and Validate the Plugin

Start a Claude Code session with the plugin directory:

```bash
claude --plugin-dir ./plugins/claude-code-attention
```

Validate the manifest and mod hooks statically:

```bash
claude plugin validate ./plugins/claude-code-attention
```

## Live Attention Pane

Run `/archon-attention` in Claude Code to open the live pane:

- Loads the initial open set via `archon workflow attention --all --json`.
- Streams updates via `archon workflow attention --all --watch --protocol --json`, reconnecting with `--after <cursor>` on disconnect (and resetting the cursor cleanly on `cursor_invalid`).
- Shows each item's project, workflow/item key, question, `why it matters` context, recommendation and confidence, declared option consequences/costs, and evidence paths (`artifacts`, `transcript`, `branch`).
- Lets you type an optional ruling note, select a declared choice, and confirm before invoking `archon workflow respond` or `archon workflow answer --ref` via direct argv execution (never through a shell).

## Typed `answer_attention` Tool and Optional Automation Skill

The plugin registers `answer_attention` (`mcp__archon-attention__answer_attention`) with `{ ref?, run_id?, choice, text? }`. Every call validates that `choice` is declared on the target item and that required ruling text (such as for `other`) is non-empty before invoking the CLI.

To automate routine decisions when desired, invoke `/archon-attention-auto` (`plugins/claude-code-attention/skills/archon-attention-auto/SKILL.md`). The skill is opt-in (`disable-model-invocation: true`), contains no project-specific rules of its own, and directs Claude to consult the current repository's `AGENTS.md`, `.archon/direction.md`, `.archon/architecture.md`, `.archon/engineering.md`, and prior rulings — leaving product-direction, ambiguous, or irreversible decisions for a human operator.
