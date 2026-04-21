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

## Claude Code is required

Archon orchestrates Claude Code; it does not bundle it. Install Claude Code separately:

```bash
# macOS / Linux / WSL (Anthropic's recommended installer)
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

Source installs (`bun run`) find the executable automatically via `node_modules`. Compiled binaries (quick install, Homebrew) must point at the Claude Code executable:

```bash
# After the native installer:
export CLAUDE_BIN_PATH="$HOME/.local/bin/claude"

# After `npm install -g @anthropic-ai/claude-code`:
export CLAUDE_BIN_PATH="$(npm root -g)/@anthropic-ai/claude-code/cli.js"
```

Or set it durably in `~/.archon/config.yaml`:

```yaml
assistants:
  claude:
    claudeBinaryPath: /absolute/path/to/claude
```

Docker images (`ghcr.io/coleam00/archon`) ship with Claude Code pre-installed and
`CLAUDE_BIN_PATH` pre-set — no configuration needed.

See [AI Assistants → Claude Code](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only)
for full details and install-layout paths.

## Verify Installation

```bash
archon version
```

## Next Steps

- [Core Concepts](/getting-started/concepts/) — Understand workflows, nodes, commands, and isolation
- [Quick Start](/getting-started/quick-start/) — Run your first workflow
- [Configuration](/getting-started/configuration/) — Set up API keys and preferences
