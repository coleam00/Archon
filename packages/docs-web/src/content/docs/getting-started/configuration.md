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

Set these in your shell, `~/.archon/.env` for user-wide settings, or `<cwd>/.archon/.env` for project overrides. The CLI strips keys named in a target repository's `<cwd>/.env`; use the Archon-owned files for credentials. See [environment file locations and load order](/reference/configuration/#env-file-locations), including the source-server exception.

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_BIN_PATH` | No (binary builds autodetect `~/.local/bin/claude`) | Absolute path to the Claude Code binary, SDK `cli.js`, or the npm platform-package directory (e.g. `@anthropic-ai/claude-code-win32-x64`, auto-expanded to `claude`/`claude.exe`). Takes precedence over `assistants.claude.claudeBinaryPath` in both source and compiled installs. Without either pin, compiled builds autodetect the native-installer path; dev mode (`bun run`) lets the SDK resolve via `node_modules`. Invalid explicit pins fail in either mode. |
| `CLAUDE_USE_GLOBAL_AUTH` | No | Startup-check marker for a `claude /login` session; Claude Code never reads it. Set automatically when no other Claude token is set. A Docker container has no login session, so set a token or key there. |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | OAuth token from `claude setup-token` |
| `CLAUDE_API_KEY` | No | Anthropic API key for pay-per-use |
| `CODEX_BIN_PATH` | No | Absolute path to the Codex CLI binary. Overrides auto-detection in compiled Archon builds. |
| `ARCHON_CODEX_ACCESS_TOKEN` | No | Docker only: one of four copied Codex login values the container writes to `~/.codex/auth.json`. Elsewhere use `codex login` or `CODEX_API_KEY` (see [AI Assistants](/getting-started/ai-assistants/)) |
| `DATABASE_URL` | No | PostgreSQL connection string (default: SQLite) |
| `GH_TOKEN` | No | GitHub personal access token — used to authenticate when cloning private repos from `github.com` or the `GITHUB_URL` host |
| `GITHUB_URL` | No | GitHub Enterprise Server base URL (e.g. `https://github.example.com`); unset means github.com. See [GitHub Enterprise Server](/adapters/github/#github-enterprise-server) |
| `GITLAB_TOKEN` | No | GitLab personal/project access token — used to authenticate when cloning private repos from `gitlab.com` or the `GITLAB_URL` host (also used by the GitLab adapter) |
| `GITEA_TOKEN` | No | Gitea/Forgejo access token — used to authenticate when cloning private repos from `gitea.com` or the `GITEA_URL` / `FORGEJO_URL` host (also used by the Gitea adapter) |
| `LOG_LEVEL` | No | `debug`, `info` (default for the server and `archon serve`), `warn` (default for other CLI commands), `error`. See [CLI logs](/reference/cli/#logs). |
| `PORT` | No | Server port (default: 3090, Docker: 3000) |
| `WSL_DISTRO_NAME` | No (WSL sets it automatically) | WSL distro name; Archon reads it to emit Windows-host-friendly `vscode://vscode-remote/wsl+<distro>/...` "Open in IDE" links. Override only to force a specific distro name into the URI. |

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
