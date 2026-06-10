---
title: Security
description: Security model, permissions, authorization, and data privacy in Archon.
category: reference
audience: [user, operator]
sidebar:
  order: 8
---

This page covers Archon's security model: how AI permissions work, how platform access is controlled, how webhooks are verified, and what data is and is not logged.

## Permission Model

Archon runs the Claude Code SDK in `bypassPermissions` mode. This means the AI agent can read, write, and execute files without interactive confirmation prompts.

**Why this is used:**
- Archon is designed for automated, unattended workflows triggered from Slack, Telegram, GitHub, and other platforms where there is no human at a terminal to approve each action.
- Requiring interactive permission prompts would block every workflow and make remote operation impossible.

**What this means in practice:**
- The AI assistant has full read/write access to the working directory (the cloned repository or worktree).
- It can run shell commands, modify files, and use all tools available to the Claude Code SDK.
- There is no per-action confirmation step.

**Mitigations:**
- Each conversation runs in an isolated git worktree by default, limiting the blast radius of any changes.
- Workflows support per-node tool restrictions (see below) to constrain what the AI can do at each step.
- The system is designed as a single-developer tool -- there is no multi-tenant isolation.

:::caution
Because `bypassPermissions` grants full file and shell access, only run Archon in environments where the AI agent is trusted with the repository contents. Do not expose Archon to untrusted users without adapter-level authorization (see below).
:::

## Tool Restrictions

Workflow nodes support `allowed_tools` and `denied_tools` to restrict which tools the AI can use at each step. This is useful for creating sandboxed steps that can only read code (not modify it) or preventing specific tool usage.

```yaml
nodes:
  - id: review
    prompt: "Review the code for security issues"
    allowed_tools: [Read, Grep, Glob]  # Can only read, not write

  - id: implement
    prompt: "Fix the issues found"
    denied_tools: [WebSearch, WebFetch]  # No internet access
```

**How it works:**
- `allowed_tools` is a whitelist -- only listed tools are available. An empty list (`[]`) disables all tools.
- `denied_tools` is a blacklist -- listed tools are blocked, all others are available.
- These are mutually exclusive per node. If both are set, `allowed_tools` takes precedence.
- Tool restrictions are currently supported for the Claude provider only. Codex nodes with `denied_tools` will log a warning; `allowed_tools` is not supported by the Codex SDK.

## Data Privacy and Logging

Archon uses structured logging (Pino) with explicit rules about what is and is not recorded.

**Never logged:**
- API keys or tokens (masked to first 8 characters + `...` when referenced)
- User message content (the text users send to the AI)
- Personally identifiable information (PII)

**Logged (with context):**
- Conversation IDs, session IDs, workflow run IDs
- Event names (e.g., `session.create_started`, `workflow.step_completed`)
- Error messages and types (for debugging)
- Unauthorized access attempts (with masked user IDs, e.g., `abc***`)

**Log levels:**
- Default: `info` (operational events only)
- Set `LOG_LEVEL=debug` for detailed execution traces
- CLI: `--quiet` (errors only) or `--verbose` (debug)

## Anonymous Telemetry

Separate from local logging, Archon sends a small set of **anonymous** usage events to PostHog (`archon_started`, `archon_active` daily server heartbeat, `chat_turn_handled` — platform + provider only, never message content, `workflow_invoked`, `workflow_completed`/`workflow_failed`, `codebase_registered` — a pure count, no name/path/URL) so maintainers can see active installs, which workflows run, and run outcomes. Events are keyed by a random install UUID — never user identity.

Only categorical data is sent: bundled workflow name (user-authored workflows report `"custom"`), platform, provider/model id, node shape and feature-adoption flags, run outcome/duration, a fixed-enum failure class (`fatal`/`transient`/`unknown` — derived locally, never the error text itself), deployment shape (which adapters/db/auth modes are enabled — booleans and enums, never configuration values), and machine context (OS, arch, version, runtime). **Never sent:** code, prompts, chat message content, conversation ids, file paths, IP (dropped at ingest), geolocation, error text, or custom workflow names. See the [Telemetry table in the configuration reference](/reference/configuration/) for the full field list and opt-out options (`DO_NOT_TRACK=1`, `ARCHON_TELEMETRY_DISABLED=1`, CI auto-disable, or `POSTHOG_API_KEY=off`).

## Adapter Authorization

Each platform adapter supports an optional user whitelist via environment variables. When a whitelist is configured, only listed users can interact with the bot. When the whitelist is empty or unset, the adapter operates in open access mode.

| Platform | Whitelist Variable | Format |
| --- | --- | --- |
| Slack | `SLACK_ALLOWED_USER_IDS` | Comma-separated Slack user IDs (e.g., `U01ABC,U02DEF`) |
| Telegram | `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |
| Discord | `DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user IDs |
| GitHub | `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames (case-insensitive) |
| Gitea | `GITEA_ALLOWED_USERS` | Comma-separated Gitea usernames (case-insensitive) |

**Authorization behavior:**
- Whitelist is parsed once at adapter startup (from the environment variable).
- Every incoming message or webhook is checked before processing.
- Unauthorized users are silently rejected -- no error response is sent back.
- Unauthorized attempts are logged with masked user identifiers for auditing.
- SQLite/solo installs have no built-in user authentication -- use `CADDY_BASIC_AUTH` or form auth to protect the Web UI when exposing it publicly (see [Docker / Deployment](/reference/configuration/#docker--deployment) variables). PostgreSQL deployments can additionally enable optional per-user email/password login via Better Auth (`BETTER_AUTH_SECRET`).
- When web auth is enabled it **gates the API server-side**: every `/api/*` request needs a session/identity or gets `401`, except `/api/auth/*` (login) and `/api/health*` (healthcheck). This makes Better Auth the real access boundary — so you can drop the Caddy `forward_auth` sidecar and stop the `auth-service`. **Before flipping, understand the header-trust caveat:** the gate also accepts the trusted `X-Archon-User` (`ARCHON_WEB_AUTH_HEADER`) header as an identity. If your proxy was setting or stripping that header, you MUST keep stripping it from inbound requests after retiring the sidecar (or bind the app to `127.0.0.1`) — otherwise any client can forge the header and bypass the gate. To flip the deployment: confirm `/api/health` and a webhook still work, then sign in and confirm an authenticated `/api/*` call succeeds — note `/api/stream/*` (SSE) is under `/api/*` and **is now gated**, so an unauthenticated client gets `401`; a browser carrying its session cookie reaches it. Then remove the `forward_auth` block from the Caddyfile and the `auth-service` from compose. Set `ARCHON_WEB_AUTH_REQUIRED=false` to keep login-UI-only (e.g. when a proxy still gates access).
- **Signup is closed by default.** With web auth on and no `ARCHON_AUTH_ALLOWED_EMAILS`, self-serve registration is **disabled** (login only) and the server logs `web_auth.signup_disabled_no_allowlist` at boot — it never silently opens public signup on a reachable URL. Set the allowlist to invite teammates, or `ARCHON_AUTH_OPEN_SIGNUP=true` for open signup.

## Webhook Security

The GitHub and Gitea adapters verify webhook signatures to ensure payloads originate from the configured platform and have not been tampered with.

**GitHub:**
- Uses the `X-Hub-Signature-256` header
- HMAC SHA-256 computed over the raw request body using `WEBHOOK_SECRET`
- Timing-safe comparison prevents timing attacks
- Invalid signatures are rejected and logged

**Gitea:**
- Uses the `X-Gitea-Signature` header (raw hex, no `sha256=` prefix)
- Same HMAC SHA-256 verification and timing-safe comparison
- Invalid signatures are rejected and logged

**Setup:**
1. Generate a random secret: `openssl rand -hex 32`
2. Set it in both the platform webhook configuration and Archon's environment (`WEBHOOK_SECRET` for GitHub, `GITEA_WEBHOOK_SECRET` for Gitea)
3. The secrets must match exactly

## Secrets Handling

**Environment files:**
- All secrets (API keys, tokens, webhook secrets) belong in archon-owned `.env` files (`~/.archon/.env` or `<cwd>/.archon/.env`), never in source control.
- Never put archon secrets in `<cwd>/.env` — that file is stripped at boot (see below) and `archon setup` never writes to it. Put them in `~/.archon/.env` (home scope) or `<cwd>/.archon/.env` (project scope).
- Archon's `.gitignore` excludes `.env` files. `<cwd>/.archon/.env` should also be gitignored (project-local secrets).

**Subprocess env isolation:**
- At startup, `stripCwdEnv()` removes **all** keys that Bun auto-loaded from the CWD `.env` files (`.env`, `.env.local`, `.env.development`, `.env.production`), plus nested Claude Code session markers (`CLAUDECODE`, `CLAUDE_CODE_*` except auth vars) and debugger vars (`NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`). This runs before any module reads `process.env`.
- Then `loadArchonEnv(cwd)` loads archon-owned env from `~/.archon/.env` (user scope) and `<cwd>/.archon/.env` (repo scope, wins over user) with `override: true`. Both are trusted sources — the user controls them and all keys are intentional.
- Per-codebase env vars configured via `codebase_env_vars` or `.archon/config.yaml` `env:` are merged on top at workflow execution time.
- `<cwd>/.env` is the **only** untrusted source. It belongs to the target project, not to Archon. Directory ownership (`.archon/`) is the security boundary — not the filename.

**Per-user provider credentials:**
- When `TOKEN_ENCRYPTION_KEY` (64-char hex) is set, each user can connect their own provider API key or subscription. These are encrypted at rest with **AES-256-GCM**, never logged, and **never returned by any endpoint** — responses carry only `provider`/`kind`/`label` metadata. See [AI Provider Credentials](/reference/api/#ai-provider-credentials).
- The credential routes (`/api/auth/providers*`) require a resolved identity (the `X-Archon-User` header or a Better Auth session). The model-config routes (`/api/config/*`, including `tiers`) are intentionally **ungated** — they carry no secrets (just model strings) and must work on solo installs.

### Target repo `.env` isolation

Archon prevents target repo `.env` from leaking into subprocesses through structural protection:

1. **Boot cleanup:** `stripCwdEnv()` removes Bun-auto-loaded CWD `.env` keys from `process.env` before any application code runs. **This is the primary guard** — every subprocess Archon spawns inherits from the already-cleaned `process.env`.
2. **Claude Code subprocess:** when the SDK is configured to spawn a Bun-runnable JS entry point (legacy npm-installed `cli.js`/`cli.mjs`/`cli.cjs`), Archon also passes `executableArgs: ['--no-env-file']` so Bun skips its env autoload inside the spawned process. SDK 0.2.x ships per-platform native binaries instead — those don't auto-load `.env` from cwd, so the flag is unnecessary and is omitted.
3. **Bun script nodes:** `bun --no-env-file` prevents script node subprocesses from loading target repo `.env`.
4. **Bash nodes:** Not affected — bash does not auto-load `.env` files.

Archon's own env sources (`~/.archon/.env`, dev `.env`) are loaded after the CWD strip and pass through to subprocesses normally.

**If you need env vars available during workflow execution**, use managed env injection:
- `.archon/config.yaml` `env:` section (per-repo, checked into version control)
- Web UI: Settings → Projects → Env Vars (per-codebase, stored in Archon DB)

**CORS:**
- API routes use `WEB_UI_ORIGIN` to restrict CORS. The default is `*` (allow all), which is appropriate for local single-developer use. Set a specific origin when exposing the server publicly.

**Docker deployments:**
- `CLAUDE_USE_GLOBAL_AUTH=true` does not work in Docker (no local `claude` CLI). Provide `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_API_KEY` explicitly.
- Escape `$` as `$$` in Docker Compose `.env` files to prevent variable substitution of bcrypt hashes.
