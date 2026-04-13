---
title: Installation
description: Install Archon on macOS, Linux, or Windows.
category: getting-started
audience: [user, operator]
sidebar:
  order: 0
---

## Quick Install

### macOS / Linux

```bash
curl -fsSL https://archon.diy/install | bash
```

### Windows (PowerShell)

```powershell
irm https://archon.diy/install.ps1 | iex
```

### Homebrew (macOS / Linux)

```bash
brew install coleam00/archon/archon
```

### Docker

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/coleam00/archon:latest workflow list
```

## From Source

```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
```

### Prerequisites (Source Install)

- [Bun](https://bun.sh) >= 1.0.0
- [GitHub CLI](https://cli.github.com/) (`gh`)
- [Claude Code](https://claude.ai/code) (`claude`)

> **Windows note:** Native Windows source installs need symlink support before the first workflow run. Enable Developer Mode (recommended) or run your shell as Administrator because Archon creates symlinks under `~/.archon/workspaces/`. See [Windows Setup](/deployment/windows/) for the full Windows guidance.

## Verify Installation

```bash
archon version
```

## Next Steps

- [Core Concepts](/getting-started/concepts/) — Understand workflows, nodes, commands, and isolation
- [Quick Start](/getting-started/quick-start/) — Run your first workflow
- [Configuration](/getting-started/configuration/) — Set up API keys and preferences
