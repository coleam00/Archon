---
title: AI Assistants
description: Configure Claude Code and Codex as AI assistants for Archon.
category: getting-started
area: clients
audience: [user]
status: current
sidebar:
  order: 4
---

You must configure **at least one** AI assistant. Both can be configured if desired.

## Claude Code

**Recommended for Claude Pro/Max subscribers.**

### Authentication Options

Claude Code supports three authentication modes via `CLAUDE_USE_GLOBAL_AUTH`:

1. **Global Auth** (set to `true`): Uses credentials from `claude /login`
2. **Explicit Tokens** (set to `false`): Uses tokens from env vars below
3. **Auto-Detect** (not set): Uses tokens if present in env, otherwise global auth

### Option 1: Global Auth (Recommended)

```ini
CLAUDE_USE_GLOBAL_AUTH=true
```

### Option 2: OAuth Token

```bash
# Install Claude Code CLI first: https://docs.claude.com/claude-code/installation
claude setup-token

# Copy the token starting with sk-ant-oat01-...
```

```ini
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

### Option 3: API Key (Pay-per-use)

1. Visit [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new key (starts with `sk-ant-`)

```ini
CLAUDE_API_KEY=sk-ant-xxxxx
```

### Claude Configuration Options

You can configure Claude's behavior in `.archon/config.yaml`:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
    settingSources:
      - project      # Default: only project-level CLAUDE.md
      - user         # Optional: also load ~/.claude/CLAUDE.md
```

The `settingSources` option controls which `CLAUDE.md` files the Claude Code SDK loads. By default, only the project-level `CLAUDE.md` is loaded. Add `user` to also load your personal `~/.claude/CLAUDE.md`.

### Set as Default (Optional)

If you want Claude to be the default AI assistant for new conversations without codebase context, set this environment variable:

```ini
DEFAULT_AI_ASSISTANT=claude
```

## Codex

### Authenticate with Codex CLI

```bash
# Install Codex CLI first: https://docs.codex.com/installation
codex login

# Follow browser authentication flow
```

### Extract Credentials from Auth File

On Linux/Mac:
```bash
cat ~/.codex/auth.json
```

On Windows:
```cmd
type %USERPROFILE%\.codex\auth.json
```

### Set Environment Variables

Set all four environment variables in your `.env`:

```ini
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Codex Configuration Options

You can configure Codex's behavior in `.archon/config.yaml`:

```yaml
assistants:
  codex:
    model: gpt-5.4
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live           # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
```

### Set as Default (Optional)

If you want Codex to be the default AI assistant for new conversations without codebase context, set this environment variable:

```ini
DEFAULT_AI_ASSISTANT=codex
```

## How Assistant Selection Works

- Assistant type is set per codebase via the `assistant` field in `.archon/config.yaml` or the `DEFAULT_AI_ASSISTANT` env var
- Once a conversation starts, the assistant type is locked for that conversation
- `DEFAULT_AI_ASSISTANT` (optional) is used only for new conversations without codebase context
- Workflows can override the assistant on a per-node basis with `provider` and `model` fields
- Configuration priority: workflow-level options > config file defaults > SDK defaults
