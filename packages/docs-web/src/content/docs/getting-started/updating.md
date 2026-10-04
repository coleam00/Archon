---
title: Updating Archon
description: Update an existing Archon installation.
category: getting-started
audience: [user, operator]
sidebar:
  order: 1
---

Use the same method you used to [install Archon](/getting-started/installation/).
Read the [release notes](https://github.com/coleam00/Archon/releases) before updating.
Let active workflows finish and stop any running Archon server before replacing
its executable or source checkout. Restart the server afterward so the console
and new runs use the updated version.

## Homebrew

```bash
brew update
brew upgrade archon
archon version
```

## Quick installer

Re-run the installer to download and replace the executable with the latest release.

### macOS / Linux

```bash
curl -fsSL https://archon.diy/install | bash
archon version
```

### Windows (PowerShell)

```powershell
irm https://archon.diy/install.ps1 | iex
archon version
```

## Docker

For the release image shown in the installation guide, pull the new image before
starting another container:

```bash
docker pull ghcr.io/coleam00/archon:latest
docker run --rm -v "$PWD:/workspace" ghcr.io/coleam00/archon:latest version
```

For a long-running container, stop and recreate it using the same volumes,
environment, and ports as the original container. Restarting an existing container
does not change its image. Keep your data volumes.

The repository's Docker Compose deployment builds from source. Follow its
[update instructions](/deployment/docker/#update), retaining the profiles you
used for deployment; rebuilding and recreating the app loads the updated source.

## From source

In your Archon checkout, first check for local changes:

```bash
git status
```

Commit or stash your changes before updating. The `main` branch contains releases;
`dev` is the working development branch.

```bash
git switch main
git pull --ff-only
bun install --frozen-lockfile
bun run cli version
```

If you serve the console from source, rebuild it with `bun run build:web` before
restarting your server.

## Update notices

Compiled CLI installs check for updates in the background during `workflow run`
and `workflow resume`. When fresh release data is available, they print update
instructions to stderr at most once every 24 hours, even when the command fails.
`--quiet` and `--json` suppress this notice. An unavailable network or stale cache
does not delay the command.

The console shows a banner when a newer release is available. Dismissing it is
remembered in your browser for that release; a later release shows the banner again.
