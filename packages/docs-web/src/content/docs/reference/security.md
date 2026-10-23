---
title: Security
description: Security model, permissions, authorization, and data privacy in Archon.
category: reference
audience: [user, operator]
sidebar:
  order: 8
---

This page covers Archon's security model: how AI permissions work, how platform access is controlled, how webhooks are verified, and what data is and is not logged.

## Users and roles

Archon creates new users as `member`, including first-seen chat, forge, web and CLI identities. Roles are stored on the Archon user; identities are per platform, so a Slack identity and a web identity usually refer to separate users. The local operator manages roles through the CLI using the full Archon user id shown by `list`:

```bash
archon user list
archon user role <id> admin
archon user role <id> member
```

Use the database configured for the install you want to manage (`DATABASE_URL` for PostgreSQL, or `ARCHON_HOME` for SQLite). For Docker:

```bash
docker compose exec -u appuser app bun run cli user list
docker compose exec -u appuser app bun run cli user link <id> slack:U123
docker compose exec -u appuser app bun run cli user role <id> admin
```

Upgrading preserves existing roles, which defaulted to `admin`. The database default remains `admin` so older binaries can still insert users without a role. To prepare an existing multi-user install, keep intended admins and deliberately demote other users with `archon user role <id> member`.

Only a run's starter or an admin can act on it; see [Who can act on a run](#who-can-act-on-a-run). Existing multi-user installs remain unprotected until the operator demotes users who should not be admins. The CLI is the local operator with direct database access and can change roles even when no admins remain.

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

## Git directory trust

Archon's core and webhook clone handlers and worktree provider add clone destinations and worktree paths to the running user's global Git `safe.directory` configuration before checkout hooks or validation run Git in them. Git consults that list only for a repository owned by another user, so on POSIX Archon skips the grant for a path not created yet when the running user (other than root) owns its nearest existing parent. Repeated setup removes duplicate exact entries from the global config files; a required config-write failure stops setup.

Registering an existing local repository (Settings → Projects or `/register-project`) adds that exact path to the same list only when Git refuses it solely because another user owns it, as with a Docker bind mount. A path Git already accepts, or refuses for another reason (missing, unreadable, not a repository), gets no grant. Git matches the repository's top level, so register the repository root: a subdirectory of a repository owned by another user stays refused.

If Git evaluates the same file more than once, for example through an include or symlinked XDG and home config files, its effective config can still list that single physical grant multiple times. Archon preserves those includes and symlinks.

These grants persist if cloning, registration or worktree setup fails, adoption is rejected, or the checkout is later removed. Archon does not revoke them automatically: another concurrent setup may rely on the same grant. Git will continue to trust a later checkout placed at that path. Operators own removal of grants they no longer need from the same user's global Git config.

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
- If both are set, the provider's own precedence applies. Copilot gives `allowed_tools` precedence over `denied_tools` instead of removing the denied tools from the allowed set.
- Support and tool names depend on the provider. See [Provider capabilities](/reference/provider-capabilities/#capabilities) for tool restriction support.

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
- Server and `archon serve`: `info` (operational events only)
- Other CLI commands: `warn` (warnings and errors), on stderr
- Set `LOG_LEVEL=debug` or pass `--verbose` for detailed execution traces

## Anonymous Telemetry

Separate from local logging, Archon sends a small set of **anonymous** usage events to PostHog (`archon_started`, `archon_active` daily server heartbeat, `chat_turn_handled` — platform, provider, model, duration, and usage totals; never message content, `workflow_no_match` — agent-reported no-fit count and transport only, `workflow_invoked`, `workflow_completed`/`workflow_failed`/`workflow_cancelled`, `workflow_approval_resolved` — binary approve/reject only, `codebase_registered` — a pure count, no name/path/URL) so maintainers can see active installs, which workflows run, and run outcomes. Events are keyed by a random install UUID — never user identity.

Only categorical data is sent: bundled workflow name (user-authored workflows report `"custom"`), platform, provider/model id, node shape (counts per node type, graph depth, fan-out, command-reference count, a prompt-size bucket) and feature-adoption flags, the name of the bundled workflow a custom workflow was copied from (never the copy's own name), run outcome/duration, aggregate usage totals (token counts, cost USD, loop iterations — numbers only), a fixed-enum failure class recorded where a node failed (never the error text itself), a `run_ref` hash of the install and run ids (never the run id), deployment shape (which adapters/db/auth modes are enabled — booleans and enums, never configuration values), and machine context (OS, arch, version, runtime, install channel, build commit). **Never sent:** code, prompts, chat message content, conversation ids, file paths, IP (dropped at ingest), geolocation, error text, or custom workflow names. See the [Telemetry table in the configuration reference](/reference/configuration/) for the full field list and opt-out options (`DO_NOT_TRACK=1`, `ARCHON_TELEMETRY_DISABLED=1`, CI auto-disable, or `POSTHOG_API_KEY=off`).

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
- **Operator conversations are private to their owner.** When web auth is enabled, or `ARCHON_WEB_AUTH_HEADER` is set for a proxy-authenticated install, a `web` or `cli` conversation belongs to the user who created it. The conversation list shows only the caller's own web and CLI conversations. Opening, reading history, streaming over `/api/stream/<id>`, renaming, deleting, sending, starting a workflow run in it, and resetting its workflow node sessions all return `404` to anyone else, the same response as a conversation that does not exist. A request without an identity gets `401`, and an identity-backend outage gets `503`; neither falls back to listing every conversation. Sending and starting a run act on the `web` conversation with that id, and streaming prefers it, so a Slack or other chat conversation sharing the id admits nobody to a web chat; streaming a run started from chat or a forge follows that platform's access model. Sending or starting a run with an unknown id is refused rather than creating it. Resetting node sessions across all scopes is refused with `403`. Existing ownerless web and CLI conversations become inaccessible when enforcement is enabled; start a new chat for those. Conversations that already have an owner remain available to that owner. A run's own transcript (its hidden worker conversation, or a CLI run's conversation) stays readable to any signed-in user, like the run itself. Chat and forge platforms (Slack, Discord, Telegram, GitHub, GitLab, Gitea) keep their own access model, and solo installs are unchanged. **Ownership inherits the header-trust caveat above:** the owner is whoever `X-Archon-User` names, so a proxy must strip client-supplied values or any client can read another user's chats. A proxy that sends the default `X-Archon-User` header without setting `ARCHON_WEB_AUTH_HEADER` does not turn ownership on; set the variable.
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
- Keep secrets (API keys, tokens, webhook secrets) in Archon-owned `.env` files (`~/.archon/.env` or `<cwd>/.archon/.env`), never in source control. A server running from source also supports the Archon checkout's root `.env`, as used by the developer setup.
- Do not put Archon secrets in a target repository's `<cwd>/.env`: its keys are stripped at boot and its values are not loaded. When CWD is Archon's own source checkout, the source server deliberately reloads that checkout's root `.env` after stripping. The CLI and compiled server do not reload it. `archon setup` writes only to `~/.archon/.env` (home scope) or `<cwd>/.archon/.env` (project scope).
- Archon's `.gitignore` excludes `.env` files. `<cwd>/.archon/.env` should also be gitignored (project-local secrets).

**Subprocess env isolation:**
- At startup, `stripCwdEnv()` removes **all** keys named in the CWD project env files (`.env`, `.env.local`, `.env.development`, `.env.production`), whatever their value or source, including shell exports and direnv. Selected chat scope comes from the explicit `--chat-project-id` CLI argument, independent of env loading. It also strips nested Claude Code session markers (`CLAUDECODE`, `CLAUDE_CODE_*` except auth vars) and debugger vars (`NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`). This runs before any module reads `process.env`. A detached child (`--internal-detached-run-config`) then restores Archon's own install-context keys (`TOKEN_ENCRYPTION_KEY`, `ARCHON_HOME`, `ARCHON_DOCKER`, `WORKSPACE_PATH`, `HOME`, and `USERPROFILE`) from the trusted detached config, never from the project `.env`.
- A source-checkout server then loads `<archon-checkout>/.env`, resolved from the server source location rather than CWD, without `override`: values remaining in the process environment win. This is Archon's own configuration, not a separate target repository's `.env`. The CLI and compiled server skip this step.
- Then `loadArchonEnv(cwd)` loads archon-owned env from `~/.archon/.env` (user scope) and `<cwd>/.archon/.env` (repo scope) with `override: true`. Repository env normally overrides user env. The CLI's `loadCliEnv` wrapper preserves the user-scope `GH_CONFIG_DIR` (including its absence), preventing repository env from redirecting the stored gh login. Inside a workflow, the CLI preserves inherited GitHub identity values over both env files, including empty values that disable host credentials. The standalone server follows the general load order, so repository env can override its `GH_CONFIG_DIR`. See [forge plugin configuration](/reference/forge/#plugin-configuration). The repo scope cannot set `ARCHON_HOME`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER`, `WORKSPACE_PATH` or `PATH`; Archon refuses to start if it does, so a repository cannot choose which Archon home or plugin executables are used.
- Per-codebase env vars configured via `codebase_env_vars` or `.archon/config.yaml` `env:` are merged on top at workflow execution time.
- A separate target repository's CWD env files are untrusted sources. They belong to the target project, not to Archon. The source server's checkout-root exception does not load a separate target repository's `.env`. See [`.env` file locations](/reference/configuration/#env-file-locations) for the complete load order.

**Per-user provider credentials:**
- In per-user GitHub mode, conversation titles use the requesting user's credential for the title model. If that credential is absent or unusable, title generation is skipped. Delivered per-user credentials take precedence over installation and project authentication settings; requests without a per-user delivery keep native provider precedence.
- Each user can connect their own provider API key or subscription. Credentials are encrypted at rest with **AES-256-GCM** using an auto-provisioned key (`~/.archon/credential-key`) or an explicit `TOKEN_ENCRYPTION_KEY` on managed installs. Credentials are never logged and **never returned by any endpoint** — responses carry only `provider`/`kind`/`label` metadata. See [AI Provider Credentials](/reference/api/#ai-provider-credentials).
- The credential routes (`/api/auth/providers*`) require a resolved identity (the `X-Archon-User` header or a Better Auth session). The model-config routes (`/api/config/*`, including `tiers`) carry no secrets and work without an identity on solo installs. They follow the general API authentication gate when it is enabled. Credential routes require identity even when that gate is off.

### Target repo `.env` isolation

Archon prevents target repo `.env` from leaking into subprocesses through structural protection:

1. **Boot cleanup:** `stripCwdEnv()` removes from `process.env` every key named in the CWD project env files, regardless of value or source, before any application code runs. A detached child (`--internal-detached-run-config`) then restores Archon's own install-context keys (`TOKEN_ENCRYPTION_KEY`, `ARCHON_HOME`, `ARCHON_DOCKER`, `WORKSPACE_PATH`, `HOME`, and `USERPROFILE`) from the trusted detached config, never from the project `.env`. **This is the primary guard** — every subprocess Archon spawns inherits from the already-cleaned `process.env`.
2. **Claude Code subprocess:** when the SDK is configured to spawn a Bun-runnable JS entry point (legacy npm-installed `cli.js`/`cli.mjs`/`cli.cjs`), Archon also passes `executableArgs: ['--no-env-file']` so Bun skips its env autoload inside the spawned process. SDK 0.2.x ships per-platform native binaries instead — those don't auto-load `.env` from cwd, so the flag is unnecessary and is omitted.
3. **Bun script nodes:** `bun --no-env-file` prevents script node subprocesses from loading target repo `.env`.
4. **Bash nodes:** Not affected — bash does not auto-load `.env` files.

This strict deletion prevents a project `ANTHROPIC_API_KEY` from overriding Claude subscription authentication and billing the API instead. It also prevents project keys, including shell or direnv values with the same names, from overriding Archon's defaults or environment. Chat project scope uses `--chat-project-id`, so env files cannot supply or override it.

Put install credentials such as `GH_TOKEN` in `~/.archon/.env`. Archon's own env sources (`~/.archon/.env`, `<cwd>/.archon/.env`, and the Archon checkout's root `.env` for a source server) load after the strip and pass through to subprocesses normally. The source server loads its checkout file first, without override; the two `.archon/.env` files then override it. The CLI and compiled server load only the `.archon/.env` files. The strip removes project key names at boot; it does not forbid explicitly supplying those names through Archon's later trusted env layers.

**If you need env vars available during workflow execution**, use managed env injection:
- `.archon/config.yaml` `env:` section (per-repo, checked into version control)
- Web UI: open **Environment variables** from the project row in the console project rail (per-codebase, stored in Archon DB)

**CORS:**
- API routes use `WEB_UI_ORIGIN` to restrict CORS. The default is `*` (allow all), which is appropriate for local single-developer use. Set a specific origin when exposing the server publicly.

**Docker deployments:**
- `CLAUDE_USE_GLOBAL_AUTH=true` only satisfies the server's startup check. A fresh container has no `claude /login` session, so set `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_API_KEY`.
- For Caddy Basic Auth, follow the [Docker authentication recipe](/deployment/docker/#caddy-basic-auth). Its single-quoted multiline `.env` value preserves literal `$` characters in the hash.

## Who can act on a run

Approve, reject, respond, resume, cancel, abandon, signal and delete are authorized in core operations. `/reset` authorizes every resumable run in the conversation atomically before cancelling any of them. A refusal records no decision, changes no run, and stops no owner. HTTP returns 403; chat, forge comments, tools and Slack buttons report the refusal. Reads remain open.

| Actor | Run with a starter | Run with no recorded starter |
| --- | --- | --- |
| Local operator | Allowed | Allowed |
| Admin | Allowed | Allowed |
| Member or unknown user ID | Allowed only for the starter | Refused |
| Unidentified | Refused | Refused |

The CLI is always the local operator. The console with web auth off and no resolved identity is also the operator, so a single-user install cannot be locked out. Chat and forge identities never become the operator. With web auth on, an unresolved identity is refused even when anonymous requests are admitted by the API configuration.

Roles are read on each action. An operator can grant admin with `archon user role <user-id> admin`. Users are identified per platform: a member who starts a run on Slack cannot approve it from the web with a separate identity. Named gate approvers are not supported.

Existing users keep their admin role on upgrade. Existing multi-user installs stay unprotected until the operator demotes users with `archon user role <user-id> member`.
