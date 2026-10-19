---
title: Installation
description: Install Archon on macOS, Linux, or Windows.
category: getting-started
audience: [user, operator]
sidebar:
  order: 0
---

## Quick Install

Release binaries ship without AI providers. The quick installers ask which of
Claude, Codex and Pi to add and run `archon provider add` for your
selection; Homebrew prints the command instead. See [Providers](#providers).

### macOS / Linux

```bash
curl -fsSL https://archon.diy/install | bash

# Choose providers without the question
curl -fsSL https://archon.diy/install | bash -s -- --providers codex
```

> **x64 compatibility:** Compiled x64 binaries require AVX2. Older Intel/AMD
> hardware and virtual machines that mask AVX2 cannot use the x64 quick install;
> use [From Source](#from-source) instead. ARM64 quick installs are unaffected.

### Windows (PowerShell)

```powershell
irm https://archon.diy/install.ps1 | iex

# Choose providers without the question
& ([scriptblock]::Create((irm https://archon.diy/install.ps1))) -Providers codex
```

### Homebrew (macOS / Linux)

```bash
brew install coleam00/archon/archon
archon setup        # or: archon provider add <claude|codex|pi>
```

### Docker

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/coleam00/archon:latest workflow list
```

## Providers

Adding a provider connects Archon to your agent CLI or SDK; it does not install that CLI.

A release binary runs only the providers you add. Each one is a separate
executable from the same release, verified against its `checksums.txt` and
recorded under `~/.archon/plugins/`:

```bash
archon provider add codex          # one provider
archon provider add claude codex pi
```

`archon setup` asks the same question and then walks through each provider's
authentication. The installers take the selection as `--providers` (shell),
`-Providers` (PowerShell) or the `ARCHON_PROVIDERS` environment variable, as a
comma-separated list; an empty value installs none. With no selection and no
terminal to ask on, the installer installs none and prints the command.
Archon never picks a provider for you: a workflow or chat message that needs a
provider you have not installed fails before it starts and names the add
command.

An installed provider must match the CLI version. After upgrading Archon, run
`archon provider add` again for each provider you use; until then those
runs fail with the command to run. Rerunning the quick installer asks again.

Releases up to 0.11.1 predate `archon provider` and bundle their providers. To
pin one with `VERSION`, skip the provider step with an empty selection
(`--providers=` or `-Providers ''`); otherwise the installer runs a command that
release does not have and exits with an error.

Docker images and source checkouts run Claude, Codex and Pi from source and need
no install step.

## Using Archon from a GUI or service

The quick installer and Homebrew install a native, compiled `archon` executable;
they do not require Bun at runtime. Each compiled invocation records its absolute
path and version in `<ARCHON_HOME>/install.json`:

```json
{
  "binary": "/usr/local/bin/archon",
  "version": "0.9.0"
}
```

Treat this file as a discovery hint, not executable configuration. An explicit
path configured by the user always wins. Otherwise, read the manifest, require
`binary` to be an absolute executable path, and launch it directly. If the file
is absent or invalid, fall back to the documented platform default or ask the
user to choose a binary. The quick-installer defaults are `/usr/local/bin/archon`
on macOS/Linux and `%USERPROFILE%\.archon\bin\archon.exe` on Windows; expand
`%USERPROFILE%` to the user's home directory before invoking the Windows path.

The last compiled Archon invoked updates the record when its path or version
changes. Quick installers create it during their final version check. Homebrew
creates it on first use. Source and Bun-linked invocations never write it.

The source-install and `bun link` workflow is for terminal development and
requires Bun on `PATH`.

## From Source

```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
```

### Prerequisites (Source Install)

- [Bun](https://bun.sh) >= 1.0.0
- [GitHub CLI](https://cli.github.com/) (`gh`)
- [Claude Code](https://claude.ai/code) (`claude`), if you use the Claude provider

## Claude Code (Claude provider only)

The Claude provider orchestrates Claude Code; it does not bundle it. If you use
Claude, install Claude Code separately:

```bash
# macOS / Linux / WSL (Anthropic's recommended installer)
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

The installed Claude provider finds Claude Code at the native installer's path (`~/.local/bin/claude`, or `%USERPROFILE%\.local\bin\claude.exe` on Windows) without configuration. Source installs (`bun run`) find it through `node_modules`. For any other install, such as `npm install -g @anthropic-ai/claude-code`, point Archon at it:

```bash
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
archon doctor     # lists installed providers and their diagnostics
```

## Next Steps

See [Updating Archon](/getting-started/updating/) for your install method.

- [Why Archon](/getting-started/why-archon/) — Workflows, nodes, commands and isolation
- [Quick Start](/getting-started/quick-start/) — Run your first workflow
- [Configuration](/getting-started/configuration/) — Set up API keys and preferences
