---
title: E2E Testing
description: Set up agent-browser for end-to-end browser testing in Archon workflows.
category: deployment
area: infra
audience: [developer, operator]
status: current
sidebar:
  order: 5
---

Archon uses [agent-browser](https://github.com/vercel-labs/agent-browser) (by Vercel Labs) for end-to-end browser testing in workflows. It is an **optional** external dependency — core Archon functionality works without it.

## Installation

```bash
# Install globally
npm install -g agent-browser

# Download browser engine (Chrome for Testing)
agent-browser install
```

## Verify Installation

```bash
agent-browser --version
# Expected: prints version number (e.g., 0.x.x)

# Quick smoke test — opens a page and closes
agent-browser open https://example.com
agent-browser close
```

## Where It's Used

No bundled workflow requires agent-browser. Your own workflows can call it from a `bash:` node or from an AI node's instructions, for example to reproduce a UI bug in a real browser or to check a change against a running dev server.

## Platform-Specific Notes

### Docker

agent-browser is **pre-installed** in the Archon Docker image. No action needed.

### macOS / Linux

Works natively after running the install commands above. If the daemon fails to start:

```bash
# Kill stale daemons and retry
pkill -f daemon.js
agent-browser open http://localhost:3090
```

### Windows

agent-browser has a [known bug](https://github.com/vercel-labs/agent-browser/issues/56) where the daemon fails to start due to Unix domain socket incompatibility on Windows.

**Workaround:** Run agent-browser inside WSL while dev servers run on Windows. See the [E2E Testing on WSL](/deployment/e2e-testing-wsl/) guide for detailed setup instructions.

## Running Without agent-browser

If agent-browser is not installed, the E2E workflow nodes will fail when the agent tries to invoke `agent-browser`. The AI agent is instructed (via prompt) to stop after 2 failed connection attempts and produce a code-review-only report — but this is a prompt-level instruction, not automated workflow logic. Results may vary depending on the AI model's adherence to the instruction.

You can safely run all non-E2E workflows without agent-browser installed.
