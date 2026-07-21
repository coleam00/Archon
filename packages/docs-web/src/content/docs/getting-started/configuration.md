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
| `CLAUDE_BIN_PATH` | No (binary builds autodetect `~/.local/bin/claude`) | Absolute path to the Claude Code binary, SDK `cli.js`, or the npm platform-package directory (e.g. `@anthropic-ai/claude-code-win32-x64`, auto-expanded to `claude`/`claude.exe`). Overrides autodetection in compiled Archon binaries. Falls back to `assistants.claude.claudeBinaryPath`, then to the native-installer path. Dev mode (`bun run`) auto-resolves via `node_modules`. |
| `CLAUDE_USE_GLOBAL_AUTH` | No | Set to `true` to use credentials from `claude /login` (default when no other Claude token is set) |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | OAuth token from `claude setup-token` (alternative to global auth) |
| `CLAUDE_API_KEY` | No | Anthropic API key for pay-per-use (alternative to global auth) |
| `CODEX_BIN_PATH` | No | Absolute path to the Codex CLI binary. Overrides auto-detection in compiled Archon builds. |
| `CODEX_ACCESS_TOKEN` | Yes (for Codex) | Codex access token (see [AI Assistants](/getting-started/ai-assistants/)) |
| `DATABASE_URL` | No | PostgreSQL connection string (default: SQLite) |
| `GH_TOKEN` | No | GitHub personal access token — used to authenticate when cloning private GitHub repos |
| `GITLAB_TOKEN` | No | GitLab personal/project access token — used to authenticate when cloning private GitLab repos (also used by the GitLab adapter) |
| `GITEA_TOKEN` | No | Gitea/Forgejo access token — used to authenticate when cloning private Gitea/Forgejo repos (also used by the Gitea adapter) |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, `error` |
| `PORT` | No | Server port (default: 3090, Docker: 3000) |
| `WSL_DISTRO_NAME` | No (WSL sets it automatically) | WSL distro name; Archon reads it to emit Windows-host-friendly `vscode://vscode-remote/wsl+<distro>/...` "Open in IDE" links. Override only to force a specific distro name into the URI. |

## Streaming Modes

Chat adapters support two response-delivery modes, configured per-platform via the `*_STREAMING_MODE` environment variables:

| Mode | Behavior | When to use |
|------|----------|-------------|
| `stream` | AI tokens are sent progressively — the bot edits its own message live as text is generated. | When the platform supports real-time message editing (Telegram, Zulip) and you want an interactive feel. |
| `batch` | The AI completes the full response before sending; a `Starting thinking…` status message gives immediate feedback while the AI works. | More reliable across platforms; recommended as the default. |

**Default modes by platform:**

| Platform | Default |
|----------|---------|
| Telegram | `stream` |
| Discord | `batch` |
| Slack | `batch` |
| Zulip | `batch` |

Override per platform via the matching env var (e.g. `ZULIP_STREAMING_MODE=stream`, `TELEGRAM_STREAMING_MODE=batch`).

## Project Configuration

Create `.archon/config.yaml` in your repository:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'inherit'
    settingSources:
      - project
  codex:
    model: gpt-5.6-sol
    modelReasoningEffort: medium

# docs:
#   path: packages/docs-web/src/content/docs  # Optional: default is docs/
```

See the [full configuration reference](/reference/configuration/) for all options.
