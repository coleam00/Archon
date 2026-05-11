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

Archon uses [agent-browser](https://github.com/vercel-labs/agent-browser) (by Vercel Labs) for end-to-end browser testing in workflows like `archon-validate-pr`. It is an **optional** external dependency — core Archon functionality works without it.

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

The following workflows and commands depend on agent-browser:

| Resource | Type | Purpose |
|----------|------|---------|
| `archon-validate-pr` | Workflow | E2E testing phase of PR validation |
| `validate-ui` | Skill | Comprehensive UI testing |
| `replicate-issue` | Skill | Issue reproduction via browser |
| `archon-validate-pr-e2e-main.md` | Command | E2E tests against the main branch |
| `archon-validate-pr-e2e-feature.md` | Command | E2E tests against the feature branch |

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
