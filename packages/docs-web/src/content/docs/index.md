---
title: Archon
description: AI workflow engine — package your coding workflows as YAML, run them anywhere.
template: splash
hero:
  title: Archon
  tagline: Package your AI coding workflows as YAML. Run them anywhere — CLI, Web, Slack, Telegram, GitHub, Discord.
  actions:
    - text: Get Started
      link: /getting-started/installation/
      icon: right-arrow
      variant: primary
    - text: Roadmap
      link: /roadmap/
      icon: right-arrow
      variant: secondary
    - text: View on GitHub
      link: https://github.com/coleam00/Archon
      icon: external
      variant: minimal
---

## Install in seconds

:::code-group

```bash [macOS / Linux]
curl -fsSL https://archon.diy/install | bash
```

```powershell [Windows]
irm https://archon.diy/install.ps1 | iex
```

```bash [Homebrew]
brew install coleam00/archon/archon
```

```bash [Docker]
docker run --rm -v "$PWD:/workspace" ghcr.io/coleam00/archon:latest workflow list
```

:::

## What is Archon?

Archon is a **workflow engine for AI coding agents**. Define multi-step development workflows in YAML — code review, bug fixes, feature implementation, testing — and run them with a single command.

- **Repeatable**: Package your best AI coding patterns as shareable YAML workflows
- **Isolated**: Each workflow runs in its own git worktree — no conflicts, no mess
- **Portable**: Run from CLI, Web UI, Slack, Telegram, GitHub, or Discord
- **Composable**: Chain workflow nodes into DAGs with dependencies, loops, and conditional logic
- **Multi-provider**: Works with Claude Code SDK and Codex SDK
