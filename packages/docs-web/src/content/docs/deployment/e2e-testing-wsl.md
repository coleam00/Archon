---
title: E2E Testing on WSL
description: Run agent-browser inside WSL for end-to-end testing when dev servers run on Windows.
category: deployment
area: infra
audience: [developer]
status: current
sidebar:
  order: 6
---

`agent-browser` (Vercel) has a [known Windows bug](https://github.com/vercel-labs/agent-browser/issues/56) where the daemon fails to start due to Unix domain socket incompatibility. The workaround is to run agent-browser inside WSL while the dev servers run on Windows.

> **General setup:** For non-WSL platforms (macOS, Linux, Docker), see the [E2E Testing Guide](/deployment/e2e-testing/) instead.

## Prerequisites

- WSL2 with Ubuntu installed (`wsl --list --verbose`)
- agent-browser installed in WSL: `npm install -g agent-browser`
- Playwright chromium installed: `agent-browser install --with-deps` (needs sudo)

## Setup

### 1. Find the Windows host IP accessible from WSL

```bash
ipconfig | findstr "IPv4" | findstr "WSL"
# Example output: IPv4 Address. . . . . . . . . . . : 172.18.64.1
```

Or from inside WSL:
```bash
wsl -d Ubuntu -- bash -c "cat /etc/resolv.conf | grep nameserver"
```

The Windows host IP for this system is `172.18.64.1`.

### 2. Start dev servers on Windows (bound to all interfaces)

```bash
# Backend (Hono on port 3090) - already binds to 0.0.0.0 by default
bun run dev:server &

# Frontend (Vite on port 5173) - needs --host flag
cd packages/web && bun x vite --host 0.0.0.0 &
```

### 3. Verify WSL can reach the servers

```bash
wsl -d Ubuntu -- curl -s http://172.18.64.1:3090/api/health
wsl -d Ubuntu -- curl -s -o /dev/null -w "%{http_code}" http://172.18.64.1:5173
```

## Running agent-browser Commands

All commands are run from the Windows terminal, prefixed with `wsl -d Ubuntu --`:

```bash
# Open a page
wsl -d Ubuntu -- agent-browser open http://172.18.64.1:5173

# Take interactive snapshot (get element refs like @e1, @e2)
wsl -d Ubuntu -- agent-browser snapshot -i

# Click, fill, press
wsl -d Ubuntu -- agent-browser click @e1
wsl -d Ubuntu -- agent-browser fill @e2 "some text"
wsl -d Ubuntu -- agent-browser press Enter

# Wait for content to load
wsl -d Ubuntu -- agent-browser wait 3000

# Reload page (hard refresh)
wsl -d Ubuntu -- agent-browser reload

# Close browser
wsl -d Ubuntu -- agent-browser close
```

## Taking Screenshots

Screenshots must be saved to a WSL-native path first, then copied to the Windows filesystem via the `/mnt/c/` mount:

```bash
# Save to WSL home, then copy to project
wsl -d Ubuntu -- bash -c '
  agent-browser screenshot /home/user/screenshot.png 2>&1 &&
  cp /home/user/screenshot.png /path/to/archon/e2e-screenshots/my-test.png
'
```

**Why not save directly to `/mnt/c/...`?** agent-browser resolves paths through its Node.js process, which on some setups mangles `/mnt/c/` paths (e.g., prepending `C:/Program Files/Git/`). Saving to a WSL-native path and copying avoids this.

## Gotchas

- **`localhost` doesn't work from WSL2** - must use the Windows host IP (`172.18.64.1`)
- **Vite must bind to `0.0.0.0`** - default `localhost` isn't reachable from WSL
- **Git Bash path expansion** - `/status` gets expanded to `C:/Program Files/Git/status` when passed through Git Bash. Not an agent-browser issue; it's the shell expanding `/` paths
- **SSE `Connected` indicator** - only shows for `web` platform conversations; Telegram/Slack conversations show `Disconnected` (expected)
- **Daemon startup** - if `agent-browser open` fails with "Daemon failed to start", kill stale daemons: `wsl -d Ubuntu -- pkill -f daemon.js` and retry
