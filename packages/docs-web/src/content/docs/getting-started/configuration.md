---
title: Configuration
description: Configure Archon with API keys, assistants, and project settings.
category: getting-started
area: config
audience: [user, operator]
sidebar:
  order: 3
---

## Environment Variables

Set these in your shell or `.env` file:

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_USE_GLOBAL_AUTH` | No | Set to `true` to use credentials from `claude /login` (default when no other Claude token is set) |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | OAuth token from `claude setup-token` (alternative to global auth) |
| `CLAUDE_API_KEY` | No | Anthropic API key for pay-per-use (alternative to global auth) |
| `CODEX_ACCESS_TOKEN` | Yes (for Codex) | Codex access token (see [AI Assistants](/getting-started/ai-assistants/)) |
| `DATABASE_URL` | No | PostgreSQL connection string (default: SQLite) |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |
| `PORT` | No | Server port (default: 3090, Docker: 3000) |

## Project Configuration

Create `.archon/config.yaml` in your repository:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'inherit'
    settingSources:
      - project
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
  ollama:
    model: gemma4:latest  # A model is required — Ollama has no built-in default
    # baseUrl: http://localhost:11434  # Optional

# docs:
#   path: packages/docs-web/src/content/docs  # Optional: default is docs/
```

See the [full configuration reference](/reference/configuration/) for all options.
