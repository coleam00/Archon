# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.9] - 2026-04-22

First release with working compiled binaries since v0.3.6. Both v0.3.7 and v0.3.8 were tagged but neither shipped release assets — v0.3.7 was blocked by two genuine binary-runtime bugs (Pi SDK's module-init crash + Bun `--bytecode` producing broken output), and v0.3.8 was blocked by an unrelated CI smoke-test regression where `release.yml`'s Claude resolver test required an `origin` remote that the fresh `git init` test repo didn't have. Both superseded tags remain for history; their GitHub Releases were deleted at the time of tagging so `releases/latest` fell back to v0.3.6 throughout, keeping `install.sh` and Homebrew safe. v0.3.9 is what users actually install.

### Fixed

- **Release binary smoke test no longer fails on the fresh `git init` test repo.** The Claude resolver smoke in `release.yml` ran `archon workflow run archon-assist` against a tempdir with no `origin` remote; as of #1310's worktree auto-sync logic this fails with "neither origin/HEAD nor origin/main exist" before the resolver is reached, so the CI assertion (`"Claude Code not found"` in output) never matched and the linux-x64 build aborted — taking the entire release matrix down via fail-fast. Adding `--no-worktree` to both the negative and positive resolver tests skips isolation, which is what the tests actually want: they exercise the Claude resolver path, not worktree setup. (#1357)

## [0.3.8] - 2026-04-22

Tagged but never released. Intended as the hotfix for v0.3.7's binary-runtime crashes; the code fixes shipped in v0.3.9 actually originated here (Pi SDK module-init lazy-load, Bun `--bytecode` removal). v0.3.8's own release CI aborted on an unrelated smoke-test assertion in `release.yml` and no binaries were uploaded. The GitHub Release was deleted; the tag remains for history. See v0.3.9 for the release users actually install.

### Fixed

- **Compiled archon binaries no longer crash at startup when the Pi provider is bundled.** `@mariozechner/pi-coding-agent/dist/config.js` runs `readFileSync(getPackageJsonPath(), 'utf-8')` at module top-level, which inside a compiled binary resolves to `dirname(process.execPath) + '/package.json'` — a path that doesn't exist next to `/usr/local/bin/archon`, making every archon command (including `archon version`) crash with ENOENT before it ran. The Pi SDK and all Pi-dependent helper modules are now dynamically imported inside `PiProvider.sendQuery()`; registering Pi and instantiating the provider no longer touches Pi's module-init side effects. A regression test (`provider-lazy-load.test.ts`) walks the same `registerCommunityProviders()` + `getAgentProvider('pi')` path the CLI and server take and asserts neither SDK package was resolved. Claude and Codex providers keep their static import style — their SDKs have no equivalent module-init side effect. Unblocks the v0.3.7 release binaries that could not ship because of this bug. (#1355)
- **Release binary compile no longer silently produces broken bytecode.** `scripts/build-binaries.sh` dropped the `--bytecode` flag: Bun 1.3.11's bytecode step failed with `Failed to generate bytecode for ./cli.js` against the 0.3.7 module graph and fell through to producing a binary that crashed at module instantiation with "Expected CommonJS module to have a function wrapper". Windows was already excluded; this removes the flag everywhere. Release parity preserved via `--minify`. (#1354)

## [0.3.7] - 2026-04-22

Pi community provider, home-scoped workflows/commands/scripts, worktree policy, Web UI approval-gate auto-resume, three-path env model, and a breaking change to Claude Code binary resolution for compiled binary users.

### Added

- **Pi community provider (`@mariozechner/pi-coding-agent`).** First community provider under the Phase 2 registry (`builtIn: false`). One adapter exposes ~20 LLM backends (Anthropic, OpenAI, Google, Groq, Mistral, Cerebras, xAI, OpenRouter, Hugging Face, and more) via a `<pi-provider-id>/<model-id>` model format. Reads credentials from `~/.pi/agent/auth.json` (populated by running `pi /login` for OAuth subscriptions like Claude Pro/Max, ChatGPT Plus, GitHub Copilot) AND from env vars (env vars take priority per-request). Per-node workflow options supported: `effort`/`thinking` → Pi `thinkingLevel`; `allowed_tools`/`denied_tools` → filter Pi's 7 built-in coding tools; `skills` → resolved against `.agents/skills`, `.claude/skills` (project + user-global); `systemPrompt`; codebase env vars; session resume via `sessionId` round-trip. Unsupported fields (MCP, hooks, structured output, cost limits, fallback model, sandbox) trigger an explicit dag-executor warning rather than silently dropping. Use in workflow YAML: `provider: pi` + `model: anthropic/claude-haiku-4-5`. (#1270)
- **Inline sub-agent definitions on DAG nodes (`agents:`).** Define Claude Agent SDK `AgentDefinition`s directly in workflow YAML, keyed by kebab-case agent ID. The main agent can spawn them in parallel via the `Task` tool — useful for map-reduce patterns where a cheap model (e.g. Haiku) briefs items and a stronger model reduces. Removes the need to author `.claude/agents/*.md` files for workflow-scoped helpers. Claude only; Codex and community providers that don't support inline agents emit a capability warning and ignore the field. Merges with the internal `dag-node-skills` wrapper set by `skills:` on the same node — user-defined agents win on ID collision (a warning is logged). (#1276)
- **Home-scoped commands at `~/.archon/commands/`** — personal command helpers now reusable across every repo. Resolution precedence: `<repoRoot>/.archon/commands/` > `~/.archon/commands/` > bundled defaults. Surfaced in the Web UI workflow-builder node palette under a dedicated "Global (~/.archon/commands/)" section.
- **Home-scoped scripts at `~/.archon/scripts/`** — personal Bun/uv scripts now reusable across every repo. Script nodes (`script: my-helper`) resolve via `<repoRoot>/.archon/scripts/` first, then `~/.archon/scripts/`. Repo-scoped scripts with the same name override home-scoped ones silently; within a single scope, duplicate basenames across extensions still throw (unchanged from prior behavior).
- **1-level subfolder support for workflows, commands, and scripts.** Files can live one folder deep under their respective `.archon/` root (e.g. `.archon/workflows/triage/foo.yaml`) and resolve by name or filename regardless of subfolder. Matches the existing `defaults/` convention. Deeper nesting is ignored silently — see docs for the full convention.
- **`'global'` variant on `WorkflowSource`** — workflows at `~/.archon/workflows/` and commands at `~/.archon/commands/` now render with a distinct source label (no longer coerced to `'project'`). Web UI badges updated.
- **`getHomeWorkflowsPath()`, `getHomeCommandsPath()`, `getHomeScriptsPath()`, `getLegacyHomeWorkflowsPath()`** helpers in `@archon/paths`, exported for both internal discovery and external callers that want to target the home scope directly.
- **`discoverScriptsForCwd(cwd)`** in `@archon/workflows/script-discovery` — merges home-scoped + repo-scoped scripts with repo winning on name collisions. Used by the DAG executor and validator; callers no longer need to know about the two-scope shape.
- **Workflow-level worktree policy (`worktree.enabled` in workflow YAML).** A workflow can now pin whether its runs use isolation regardless of how they were invoked: `worktree.enabled: false` always runs in the live checkout (CLI `--branch` / `--from` hard-error; web/chat/orchestrator short-circuits `validateAndResolveIsolation`), `worktree.enabled: true` requires isolation (CLI `--no-worktree` hard-errors). Omit the block to let the caller decide (current default). First consumer: `.archon/workflows/repo-triage.yaml` pinned to `enabled: false` since it's read-only.
- **Per-project worktree path (`worktree.path` in `.archon/config.yaml`).** Opt-in repo-relative directory (e.g. `.worktrees`) where Archon places worktrees for that repo, instead of the default `~/.archon/workspaces/<owner>/<repo>/worktrees/`. Co-locates worktrees with the project so they appear in the IDE file tree. Validated as a safe relative path (no absolute, no `..`); malformed values fail loudly at worktree creation. Users opting in are responsible for `.gitignore`ing the directory themselves — no automatic file mutation. Credits @joelsb for surfacing the need in #1117.
- **Three-path env model with operator-visible log lines.** The CLI and server now load env vars from `~/.archon/.env` (user scope) and `<cwd>/.archon/.env` (repo scope, overrides user) at boot, both with `override: true`. A new `[archon] loaded N keys from <path>` line is emitted per source (only when N > 0). `[archon] stripped N keys from <cwd> (...)` now also prints when stripCwdEnv removes target-repo env keys, replacing the misleading `[dotenv@17.3.1] injecting env (0) from .env` preamble that always reported 0. The `quiet: true` flag suppresses dotenv's own output. (#1302)
- **`archon setup --scope home|project` and `--force` flags.** Default is `--scope home` (writes `~/.archon/.env`). `--scope project` targets `<cwd>/.archon/.env` instead. `--force` overwrites the target wholesale rather than merging; a timestamped backup is still written. (#1303)
- **Merge-only setup writes with timestamped backups.** `archon setup` now reads the existing target file, preserves non-empty values, carries user-added custom keys forward, and writes a `<target>.archon-backup-<ISO-ts>` before every rewrite. Fixes silent PostgreSQL→SQLite downgrade and silent token loss on re-run. (#1303)
- **`getArchonEnvPath()` and `getRepoArchonEnvPath(cwd)`** helpers in `@archon/paths`, plus a new `@archon/paths/env-loader` subpath exporting `loadArchonEnv(cwd)` shared by the CLI and server entry points.
- **`registerCommunityProviders()` aggregator** in `@archon/providers`. Process entrypoints (CLI, server, config-loader) now call one function to register every bundled community provider. Adding a new community provider is a single-line edit to this aggregator rather than touching each entrypoint — makes the Phase 2 "community providers are a localized addition" promise real.
- **`contributing/adding-a-community-provider.md` guide** — contributor-facing walkthrough of the Phase 2 registry pattern using Pi as the reference implementation.
- **`CLAUDE_BIN_PATH` environment variable** — highest-precedence override for the Claude Code SDK `cli.js` path (#1176)
- **`assistants.claude.claudeBinaryPath` config option** — durable config-file alternative to the env var (#1176)
- **Release-workflow Claude subprocess smoke test** — the release CI now installs Claude Code on the Linux runner and exercises the resolver + subprocess spawn, catching binary-resolution regressions before they ship

### Changed

- **Claude Code binary resolution** (breaking for compiled binary users): Archon no longer embeds the Claude Code SDK into compiled binaries. In compiled builds, you must install Claude Code separately (`curl -fsSL https://claude.ai/install.sh | bash` on macOS/Linux, `irm https://claude.ai/install.ps1 | iex` on Windows, or `npm install -g @anthropic-ai/claude-code`) and point Archon at the executable via `CLAUDE_BIN_PATH` env var or `assistants.claude.claudeBinaryPath` in `.archon/config.yaml`. The Claude Agent SDK accepts either the native compiled binary (from the curl/PowerShell installer at `~/.local/bin/claude`) or a JS `cli.js` (from the npm install). Dev mode (`bun run`) is unaffected — the SDK resolves via `node_modules` as before. The Docker image ships Claude Code pre-installed with `CLAUDE_BIN_PATH` pre-set, so `docker run` still works out of the box. Resolves silent "Module not found /Users/runner/..." failures on macOS (#1210) and Windows (#1087).
- **Home-scoped workflow location moved to `~/.archon/workflows/`** (was `~/.archon/.archon/workflows/` — a double-nested path left over from reusing the repo-relative discovery helper for home scope). The new path sits next to `~/.archon/workspaces/`, `archon.db`, and `config.yaml`, matching the rest of the `~/.archon/` convention. If Archon detects workflows at the old location, it emits a one-time WARN per process with the exact migration command: `mv ~/.archon/.archon/workflows ~/.archon/workflows && rmdir ~/.archon/.archon`. The old path is no longer read — users must migrate manually (clean cut, no deprecation window). Rollback caveat: if you downgrade after migrating, move the directory back to the old location.
- **Workflow discovery no longer takes a `globalSearchPath` option.** `discoverWorkflows()` and `discoverWorkflowsWithConfig()` now consult `~/.archon/workflows/` automatically — every caller gets home-scoped discovery for free. Previously-missed call sites in the chat command handler (`command-handler.ts`), the Web UI workflow picker (`api.ts GET /api/workflows`), and the orchestrator's single-codebase resolve path now see home-scoped workflows without needing a maintainer patch at every new call site. Closes #1136; supersedes that PR (credits @jonasvanderhaegen for surfacing the bug class).
- **Dashboard nav tab** now shows a numeric count of running workflows instead of a binary pulse dot. Reads from the existing `/api/dashboard/runs` `counts.running` field; same 10s polling interval.
- **Workflow run destructive actions** (Abandon, Cancel, Delete, Reject) now use a proper confirmation dialog matching the codebase-delete UX, replacing the browser's native `window.confirm()` popups. Each dialog includes context-appropriate copy describing what the action does to the run record.

### Fixed

- **Web UI approval gates now auto-resume.** Previously, clicking Approve or Reject on a paused workflow from the Web UI only recorded the decision — the workflow never continued, and the user had to send a follow-up chat message (or use the CLI) to resume. Three fixes: (1) orchestrator-agent now threads `parentConversationId` through `executeWorkflow` for every web dispatch, (2) the `POST /approve` and `POST /reject` API handlers dispatch `/workflow run <name> <userMessage>` back through the orchestrator when `parent_conversation_id` is set and points at a web-platform parent (mirrors `workflowApproveCommand`/`workflowRejectCommand` on the CLI; non-web parents skip the auto-resume to prevent cross-adapter misrouting), and (3) the during-streaming status check in the DAG executor tolerates the `paused` state so a concurrent AI node in the same topological layer finishes its own stream rather than being aborted when a sibling approval node pauses the run. The Web UI reject button uses the proper `ConfirmRunActionDialog` with an optional reason textarea (was `window.confirm` in the chat card, and lacked a reason input on the dashboard) — the trimmed reason propagates to `$REJECTION_REASON` in the workflow's `on_reject` prompt. Credits @jonasvanderhaegen for surfacing and diagnosing the bug in #1147 (that PR was 87 commits stale on a dev that had since refactored the reject UX; this is a fresh re-do on current `dev`). Closes #1131.
- **Server startup no longer marks actively-running workflows as failed.** The `failOrphanedRuns()` call has been removed from `packages/server/src/index.ts` to match the CLI precedent (`packages/cli/src/cli.ts:256-258`). Per the new CLAUDE.md principle "No Autonomous Lifecycle Mutation Across Process Boundaries", a stuck `running` row is now transitioned explicitly by the user: via the per-row Cancel/Abandon buttons on the dashboard workflow card, or `archon workflow abandon <run-id>` from the CLI. (`archon workflow cleanup` is a separate command that deletes OLD terminal runs for disk hygiene — it does not handle stuck `running` rows.) Closes #1216.
- **`MCP server connection failed: <plugin>` noise no longer surfaces in workflow runs.** The dag-executor now loads the workflow node's `mcp:` config file once and filters the SDK's failure message to only the servers the workflow actually configured. User-level Claude plugin MCPs (e.g. `telegram` inherited from `~/.claude/`) that fail to connect in the headless subprocess are debug-logged as `dag.mcp_plugin_connection_suppressed` instead of being forwarded to the conversation. Other provider warnings (⚠️) surface unchanged. Credits @MrFadiAi for reporting the issue in #1134 (that PR was 9 days stale and conflicting; this is a fresh re-do on current `dev`).
- **`archon setup` no longer writes to `<repo>/.env`.** Prior versions unconditionally wrote the generated config to both `~/.archon/.env` and `<repo>/.env`, destroying user-added secrets and silently downgrading PostgreSQL configs to SQLite when re-run in "Add" mode. The write side now targets exactly one archon-owned file (home or project scope via `--scope`), merges into existing content by default, and writes a timestamped backup. `<repo>/.env` is never touched — it belongs to the user's target project. (#1303)
- **CLI and server no longer silently lose repo-local env vars.** Previously, env vars in `<repo>/.env` were parsed, deleted from `process.env` by `stripCwdEnv()`, and the only output operators saw was `[dotenv@17.3.1] injecting env (0) from .env` — which read as "file was empty." Workflows that needed `SLACK_WEBHOOK` or similar had no way to recover without knowing to use `~/.archon/.env`. The new `<cwd>/.archon/.env` path + archon-owned log lines make the load state observable and recoverable. (#1302)
- **Bumped transitive `axios` to `^1.15.0` via root `overrides` to clear CVE-2025-62718** (NO_PROXY bypass via hostname normalization → potential SSRF). Archon pulls `axios` transitively through `@slack/bolt` and `@slack/web-api`; both semver ranges (`^1.12.0` and `^1.13.5`) accept the override cleanly, so no API surface changes. Credits @stefans71 for identifying and reporting the vulnerability in #1153. Closes #1053.
- **Stale workspace symlink no longer reported as "not in a git repository" by the CLI.** When `archon workflow run` (or `--resume`) is invoked from a valid git repo whose `~/.archon/workspaces/<owner>/<repo>/source` symlink points somewhere else (common after moving/renaming the checkout), auto-registration fails but the repo is fine. Previously both the worktree-creation and resume paths fell through to the generic `Cannot create worktree: not in a git repository` / `Cannot resume: Not in a git repository` errors — a lie that sent users down the wrong diagnostic path. Both sites now preserve the registration error and throw `Cannot {create worktree,resume}: repository registration failed.` with the original cause and a concrete cleanup hint (`Remove the stale workspace entry at <path> and retry`) when the failure matches the `createProjectSourceSymlink()` shape. Credits @Bortlesboat for identifying the root cause and the parser approach in #1157. Closes #1146.
- **Cross-clone worktree isolation**: prevent workflows in one local clone from silently adopting worktrees or DB state owned by another local clone of the same remote. Two clones sharing a remote previously resolved to the same `codebase_id`, causing the isolation resolver's DB-driven paths (`findReusable`, `findLinkedIssueEnv`, `tryBranchAdoption`) to return the other clone's environment. All adoption paths now verify the worktree's `.git` pointer matches the requesting clone and throw a classified error on mismatch. `archon-implement` prompt was also tightened to stop AI agents from adopting unrelated branches they see via `git branch`. Thanks to @halindrome for the three-issue root-cause mapping. (#1193, #1188, #1183, #1198, #1206)

### Removed

- **`globalSearchPath` option** from `discoverWorkflows()` and `discoverWorkflowsWithConfig()`. Callers that previously passed `{ globalSearchPath: getArchonHome() }` should drop the argument; home-scoped discovery is now automatic.
- **`@anthropic-ai/claude-agent-sdk/embed` import** — the Bun `with { type: 'file' }` asset-embedding path and its `$bunfs` extraction logic. The embed was a bundler-dependent optimization that failed silently when Bun couldn't produce a usable virtual FS path (#1210, #1087); it is replaced by explicit binary-path resolution.

## [0.3.6] - 2026-04-12

Web UI workflow experience improvements, CWD environment leak protection, and bug fixes.

### Added

- Workflow result card now shows status, duration, node count, and artifact links in chat (#1015)
- Loop iteration progress display in the workflow execution view (#1014)
- Artifact file paths in chat messages are now clickable (#1023)

### Changed

- CWD `.env` variables are now stripped from AI subprocess environments at the `@archon/paths` layer, replacing the old `SUBPROCESS_ENV_ALLOWLIST` approach. Prevents accidental credential leaks from target repo `.env` files (#1067, #1030, #1098, #1070)
- Update check cache TTL reduced from 24 hours to 1 hour

### Fixed

- Duplicate text and tool calls appearing in workflow execution view
- `workflow_step` SSE events not handled correctly, causing missing progress updates
- Nested interactive elements in workflow UI causing React warnings
- Workflow status messages not splitting correctly in WorkflowLogs
- Incorrect `remainingMessage` suppression in stream mode causing lost output
- Binary builds now use `BUNDLED_VERSION` for the app version instead of reading `package.json`

## [0.3.5] - 2026-04-10

Fixes for `archon serve` process lifecycle and static file serving.

### Fixed

- **`archon serve` process exits immediately**: the CLI called `process.exit(0)` after `startServer()` returned, killing the server. Now blocks on SIGINT/SIGTERM so the server stays running (#1047)
- **Web dist path existence check**: server logs a warning at startup if the web dist directory is missing, instead of silently serving 404s
- **Favicon route**: added explicit `/favicon.png` route for the web UI

## [0.3.4] - 2026-04-10

Binary env loading fix and release infrastructure improvements.

### Added

- **Docs site redesign**: logo, dark theme, feature cards, and enhanced CSS (#1022)

### Changed

- **Server env loading for binary support**: removed redundant CWD `.env` stripping — `SUBPROCESS_ENV_ALLOWLIST` and the env-leak gate already prevent target repo credentials from reaching AI subprocesses. Server now loads `~/.archon/.env` with `override: true` for all keys (not just `DATABASE_URL`), skips the `import.meta.dir` `.env` path in binary mode, and defaults `CLAUDE_USE_GLOBAL_AUTH=true` when no explicit credentials are set (#1045)
- **Workspace version sync**: all `packages/*/package.json` versions now sync from the root `package.json` during releases via `scripts/sync-versions.sh`

### Fixed

- **`archon serve` crash in compiled binaries**: the CWD env stripping + baked `import.meta.dir` path caused all credentials to be lost, triggering `no_ai_credentials` exit on every startup
- **CLI `version` command reading stale version**: dev mode now reads from the monorepo root `package.json` instead of the CLI package's own version field
- **Release CI web build**: fixed `bun --filter` syntax and added missing `remark-gfm` transitive dependencies for Bun hoisting

## [0.3.3] - 2026-04-10

Binary distribution improvements, new workflow node type, and a batch of bug fixes.

### Added

- **`archon serve` command**: one-command way for compiled binary users to start the web UI server. Downloads a pre-built web UI tarball from GitHub releases on first run, verifies SHA-256 checksum, caches locally, then starts the full server (#1011)
- **Automatic update check**: binary users see a notification when a newer version is available on GitHub. Non-blocking, cached for 24 hours (#1039)
- **Script node type for DAG workflows**: `script:` nodes run inline TypeScript/Python or named scripts from `.archon/scripts/` via `bun` or `uv` runtimes. Supports `deps:` for dependency installation and `timeout:` in milliseconds (#999)
- **Codex native binary auto-resolution**: compiled builds now locate the Codex CLI binary automatically instead of requiring a manual `CODEX_CLI_PATH` override (#995, #1012)

### Fixed

- **Workflow reject ignores positional reason**: `archon workflow reject <id> <reason>` now correctly passes the reason argument to the rejection handler
- **Windows script path separators**: normalize backslashes to forward slashes in script node paths for cross-platform compatibility
- **PowerShell `Add-ToUserPath` corruption**: installer no longer corrupts `PATH` when only a single entry exists (#1000)
- **Validator `Promise.any` race condition**: script runtime checks no longer fail intermittently due to a `Promise.any` edge case (#1007, #1010)
- **Interactive-prd workflow bugs**: fixes to loop gate handling, variable substitution, and node ordering (#1001, #1002, #1003, #1005)
- **Community forge adapter exports**: added explicit export entries for Gitea and GitLab adapters so they resolve correctly in compiled builds (#1041)
- **Workflow graph view without codebase**: the web UI workflow graph now loads correctly even when no codebase is selected (#958)

## [0.3.2] - 2026-04-08

Critical hotfix: compiled binaries could not spawn Claude. Also fixes an env-leak gate false-positive for unregistered working directories.

### Fixed

- **Claude SDK spawn in compiled binaries**: the Claude Agent SDK was resolving its `cli.js` via `import.meta.url` of the bundled module, which `bun build --compile` freezes at build time to the build host's absolute `node_modules` path. Every binary shipped from CI carried a `/Users/runner/work/Archon/...` path that existed only on the GitHub Actions runner, and every `workflow run` hit `Module not found` after three retries. Now imports `@anthropic-ai/claude-agent-sdk/embed` so `cli.js` is embedded into the binary's `$bunfs` and extracted to a real temp path at runtime (#990).
- **Env-leak gate false-positive for unregistered cwd**: pre-spawn scan now skips cwd paths that aren't registered as codebases instead of blocking the workflow (#991, #992).

## [0.3.1] - 2026-04-08

Patch release: SQLite migration fix for existing databases and release build pipeline fix.

### Fixed

- **SQLite migration for `allow_env_keys`**: add the missing `allow_env_keys` column to the `codebases` schema and a migration so databases created before v0.3.0 upgrade cleanly instead of erroring on first query (#988).
- **Release workflow binary builds**: wire `.github/workflows/release.yml` back to `scripts/build-binaries.sh` so tagged releases actually produce platform binaries and `checksums.txt` (#986, #987).

## [0.3.0] - 2026-04-08

Env-leak gate hardening, SSE reliability fixes, isolation cleanup smarter merge detection, build/version improvements, and deploy hardening.

### Added

- **Env-leak gate (target repo `.env` keys)**: scan auto-loaded `.env` filenames for 7 sensitive keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) and refuse to register or spawn into a codebase whose `.env` would silently re-inject keys into Claude/Codex subprocesses. Default is fail-closed (`allow_env_keys = false`). Includes a per-codebase consent column, registration gate, pre-spawn check in both Claude and Codex clients, and a 422 API error with web UI checkbox (#1036).
- **CLI `--allow-env-keys` flag** for `archon workflow run` — grant env-leak-gate consent during auto-registration without needing the Web UI. Audit-logged as `env_leak_consent_granted` with `actor: 'user-cli'` (#973, #983).
- **Global `allow_target_repo_keys` flag** in `~/.archon/config.yaml` — bypass the env-leak gate for all codebases on this machine. Per-repo `.archon/config.yaml` `allow_target_repo_keys: false` re-enables the gate for that repo. The server emits `env_leak_gate_disabled` once per process per source the first time `loadConfig` resolves the bypass as active (#973, #983).
- **`PATCH /api/codebases/:id`** endpoint to flip `allow_env_keys` on existing codebases without delete/re-add. Audit-logged at `warn` level on every grant and revoke, including a `scanStatus` field that distinguishes "scanned" from "scan failed" so audit reviewers can tell empty key lists apart (#973, #983).
- **Settings → Projects per-row toggle** to grant or revoke env-key consent retroactively, with an "env keys allowed" badge and inline error feedback if the PATCH fails (#973, #983).
- **Startup env-leak scan**: when `allow_target_repo_keys` is not set, the server emits one `startup_env_leak_gate_will_block` warn per registered codebase whose `.env` would block the next spawn. Skipped entirely when the global bypass is active (#973, #983).
- **Squash-merge and PR-merge detection** for `isolation cleanup --merged`. Unions three signals (ancestry via `git branch --merged`, patch equivalence via `git cherry`, and PR state via `gh`) to safely clean up worktrees whose branches were squash-merged. Adds `--include-closed` flag to also remove worktrees whose PRs were closed without merging (#1027).
- **Git commit hash in `archon version`** output. Read at runtime via `git rev-parse` in dev or from a build-time constant in compiled binaries; falls back to `unknown` (#1035).

### Changed

- **Env-leak gate error messages** are now context-aware: separate remediation copy for Web Add-Project, CLI auto-register, and pre-spawn-of-existing-codebase paths. Previously every error pointed at the Web UI checkbox even from the CLI (#973, #983).
- **SSE event buffer TTL** raised from 3s to 60s and capacity from 50 to 500 events, fixing dropped `tool_result` events during the 5s reconnect grace window that left tool cards perpetually spinning. Cleanup timer now resets on each new event so the buffer is held for TTL past the most recent event, not the first one. Buffer overflow and TTL expiration now log at `warn` level for observability (#1037).
- **Binary build detection** moved from runtime env sniffing (`import.meta.dir` / `process.execPath`) to a build-time `BUNDLED_IS_BINARY` constant in `@archon/paths`. Logger uses `pino-pretty` as a destination stream on the main thread instead of a worker-thread transport, eliminating the `require.resolve('pino-pretty')` lookup that crashed inside Bun's `$bunfs` virtual filesystem in compiled binaries. Same code path runs in dev and binaries — no environment detection (#982).
- **Cloud-init deployment script** hardened: dedicated `archon` user (docker group, no sudo) with SSH keys copied from the default cloud user, 2GB swapfile to prevent OOM during docker build on small VPSes, `ufw allow 443/tcp` and `443/udp` for HTTP/3 QUIC, fail-fast on network errors, and clearer setup-complete messaging (#981).

### Fixed

- **Env-leak gate worktree path lookup**: pre-spawn consent check now falls back to `findCodebaseByPathPrefix()` when the exact path lookup misses, so workflow runs in `.../worktrees/feature-branch` correctly inherit consent from the source codebase (#1036).
- **`EnvLeakError` FATAL classification** in the workflow executor now checks `error.name === 'EnvLeakError'` directly instead of pattern-matching the message, immune to message rewording (#1036).
- **Scanner unreadable-file handling**: distinguishes `ENOENT` (skip) from `EACCES` and other errors so unreadable `.env` files surface as findings instead of silently bypassing the gate (#1036).

### Security

- The default `allow_env_keys` per codebase is `false` (fail-closed). Codebases with sensitive keys in their auto-loaded `.env` files (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) are blocked at the next workflow run. **Remediation paths** (any one): (1) remove the key from `.env`, (2) rename to `.env.secrets`, (3) toggle "Allow env keys" in Settings → Projects, (4) `archon workflow run --allow-env-keys ...`, (5) set `allow_target_repo_keys: true` in `~/.archon/config.yaml`. See `docs/reference/security.md` for full details (#1036, #973, #983).


## [0.2.12] - 2026-03-20

Chat-first navigation redesign, DAG graph viewer, per-node MCP and skills, and extensive bug fixes across the web UI and workflow engine.

### Added

- **Chat-first layout redesign** with top-level tab navigation replacing sidebar nav (#666, #673)
- **DAG workflow graph viewer** with split-panel layout for visual workflow inspection (#712)
- **Per-node MCP servers** for DAG workflows — configure MCP server files per node with env var expansion (#688)
- **Per-node skills** for DAG workflows — preload skills via AgentDefinition wrapping (#689)
- **Default worktree isolation** for CLI workflows with auto-detected base branch (#692)
- **Mission Control cards** with richer grouping by parent chat (#673)
- **Tool result capture** via PostToolUse hook streamed live to Web UI
- **Zustand state management** for workflow store, replacing manual state (#693)
- **Welcoming empty chat state** with suppressed disconnected/no-project noise (#670)
- Issue context details in workflow startup log events (#737)
- Running workflow count in health endpoint (#718, #719)
- Prerequisites section added to README quickstart

### Changed

- README restructured with content extracted to `/docs` directory
- Shared executor infrastructure extracted from monolithic executor (#685)
- Workflow discovery split into its own module for cleaner loading
- Duplicated helpers extracted across executor, command-handler, and cleanup-service (#633)
- Worktree-per-codebase limit removed
- Deduplicated `setConversationDbId` pattern across adapters (#651)

### Fixed

- SSE race condition causing loading indicators to break after first workflow invocation
- Tool call cards not rendering during live SSE streaming in chat (#754)
- Standalone active workflows not grouped into shared grid (#755)
- Conversation list not scrollable in sidebar (#747, #750)
- Duplicate tool calls in WorkflowLogs from SSE+DB merge conflicts (#705, #720, #721)
- Ghost DB entries in CLI isolation commands
- Tool output lost across periodic flush in workflow logs
- `conversationId` not URL-encoded in SSE EventSource for forge adapters (#658)
- Claude SDK crash when invoked as root (#733)
- Worktree sharing across conversations and web workers (#716)
- Orphan conversation cleanup and rename error surfacing (#726)
- Query error states missing from sidebar and context components (#727)
- localStorage guard and background polling issues (#725)
- Workflow builder black screen and DAG log filtering (#675)
- Idle timeout not detecting stuck tool calls during execution (#649)
- `commitAllChanges` failing on empty commits (#745)
- Explicit base branch config now required for worktree creation (#686)
- Subprocess-level retry added to CodexProvider (#641)
- Validate `cwd` query param against registered codebases (#630)
- Server-internal paths redacted from `/api/config` response (#632)
- SQLite conversations index missing `WHERE deleted_at IS NULL` (#629)

## [0.2.11] - 2026-03-16

Git workflow and release automation.

### Added

- **Dev branch workflow** — `dev` is now the working branch; `main` is the release branch. All feature work branches off `dev` (#684)
- **`/release` skill** — stack-agnostic release automation that generates changelog entries, bumps version, and creates a PR to main

### Changed

- GitHub default branch changed from `main` to `dev`

## [0.2.10] - 2026-03-16

CLI-Web observability overhaul, comprehensive test coverage, and per-node hooks.

### Added

- **CLI-Web observability overhaul** — DAG visualization, cancel support, metadata display, and progress tracking across CLI and Web UI
- **Per-node SDK hooks** for DAG workflows — attach static hook callbacks to individual Claude nodes for tool control and context injection (#634)
- **Multi-layer transient error retry** for SDK subprocess crashes with exponential backoff (#639)
- **Comprehensive test coverage** across all packages — postgres adapter, clone handler, orchestrator agent, error formatter, API routes (#645)
- **Windows test compatibility** — resolved 33 Windows-specific test failures (#644)

### Changed

- Tool call persistence decoupled from web adapter for cleaner architecture (#642, #652)
- Loop and DAG executors now emit structured SSE events for live tool cards (#656)

### Fixed

- Loading indicator race condition and workflow tool call duration display (#654, #655, #657)
- DAG node cancel detection during streaming and UTC timestamp elapsed time
- Idle timeout excluded from post-loop cancel classification
- Flaky message-cache test caused by `Date.now()` drift

## [0.2.9] - 2026-03-13

DAG hardening, security fixes, validate-pr workflow, and worktree lifecycle management.

### Added

- **`archon complete <branch>` command** for worktree lifecycle cleanup — removes worktree + local/remote branches (#601)
- **`--json` flag for `workflow list`** — machine-readable workflow output (#594)
- **`archon-validate-pr` workflow** with per-node idle timeout support (#635)
- **Typed SessionMetadata** with Zod validation for safer metadata handling (#600)
- **`persistSession: false`** in ClaudeProvider to avoid disk pollution from session transcripts (#626)
- **DAG workflow for GitHub issue resolution** with structured node pipeline

### Changed

- Claude Agent SDK updated to v0.2.74 (#625)

### Fixed

- **Shell injection via `$nodeId.output` in bash nodes** — output is now properly escaped (#591)
- DAG `when:` parse errors now fail-closed (skip node) instead of fail-open (#590)
- Unknown `$nodeId.output` refs warn instead of silently returning empty string (#593)
- Isolation resolver no longer swallows errors or leaks partial state (#597)
- `extractOwnerRepo` no longer silently produces `undefined` path segments (#592)
- Chat stuck states after failed message send (#578, #589)
- DAG node events properly wired to frontend (#577, #602)
- Worktree creation no longer moves canonical repo HEAD (#572)
- Conversation DELETE/PATCH now use platform ID instead of internal DB ID (#575)
- DAG workflow duration computed once for consistency (#570, #573)
- SSE gaps from ordered lock events and retract preserving tool calls (#581)
- Sidebar delete now clears selection and guards localStorage (#582)
- Git fetch errors classified in syncRepository (#574)
- `DATABASE_URL` loaded from `~/.archon/.env` for CLI/server parity
- API returns 400 when `conversationId` is provided in POST `/api/conversations` (#595)

## [0.2.8] - 2026-03-06

Skills system overhaul and workshop documentation.

### Added

- **Archon-dev skill** with routing to 10 specialized cookbooks (research, plan, implement, review, debug, commit, PR, issue)
- **Rulecheck skill** — autonomous agent that scans for CLAUDE.md rule violations, creates PRs with fixes, and notifies via Slack
- **Triage skill** — upgraded from command to skill with custom agent for GitHub issue labeling
- **Save-task-list skill** — upgraded from command to skill with SessionStart hook for task restoration
- **Replicate-issue skill** for systematic GitHub issue reproduction
- **Workshop documentation** — part 1 and part 2 guides, combined rundown, and feature coverage matrix

### Changed

- Default AI assistant switched from Codex to Claude
- Skills upgraded from `.claude/commands` to `.claude/skills` with dedicated directories

## [0.2.7] - 2026-02-26

Monorepo deep extraction and visual workflow builder.

### Added

- **Visual workflow builder** with React Flow for drag-and-drop workflow creation (#471)
- **AI-generated conversation titles** + CLI-to-Web UI integration (#515)
- **Workflow Command Center** — unified dashboard for cross-project workflow observability with pagination and filtering
- **`@archon/paths` package** extracted from `@archon/core` — path resolution and logger with zero internal deps (#483)
- **`@archon/git` package** extracted from `@archon/core` — git operations with branded types (#492)
- **`@archon/isolation` package** extracted from `@archon/core` — worktree isolation with provider abstraction (#492)
- **`@archon/adapters` package** extracted from `@archon/server` — platform adapters for Slack, Telegram, GitHub, Discord (#499)
- **`@archon/workflows` package** extracted from `@archon/core` — workflow engine with loader, router, executor, DAG (#507)

### Changed

- Backward-compat re-exports removed from `@archon/core` — use direct package imports (#512)

### Fixed

- Workflow dispatch history loss, cancel, and streaming UX (#475, #480)
- Workflow summary duplicate on chat navigation (#490)
- Text buffer flushed before workflow_dispatch SSE events (#491, #498)
- SQLite adapter RETURNING test fixture (#508)
- Mock restoration in 3 test files to prevent cross-file pollution (#509, #510)
- Windows path fixes for Archon directories

## [0.2.6] - 2026-02-21

DAG workflow engine, orchestrator agent, and per-node tool restrictions.

### Added

- **DAG workflow engine** with parallel execution, conditional branching, and `$nodeId.output` substitution (#450)
- **Orchestrator agent** that routes natural language to workflows and passes prompts through (#452)
- **Per-node and per-step tool restrictions** — `allowed_tools` and `denied_tools` for Claude nodes (#454)
- **Workflow builder backend APIs** (Phase A) — validate, fetch, save, and delete workflows (#471)
- **Session retention policy** for automatic cleanup of old sessions (#306)
- **Failed workflow resume** from prior artifacts on same branch (#440)

### Changed

- Claude Agent SDK upgraded to 0.2.45 and Codex SDK to 0.104.0 (#448)
- Workflow step lifecycle logs promoted from debug to info (#469)

### Fixed

- Router bypass when AI uses tools instead of `/invoke-workflow` (#449)
- Cancelled workflow status handled in frontend (#458)
- Workflows always run in isolated worktree regardless of registration method (#457)
- `--branch` and `--no-worktree` conflict in CLI (#545)
- `/invoke-workflow` chunk suppressed before streaming to frontend (#486)
- Idle timeout added to streaming loops to prevent executor hang (#552)
- Codex model access errors surfaced with actionable guidance (#438)

## [0.2.5] - 2026-02-17

Web UI launch, structured logging, and major stabilization.

### Added

- **Archon Web UI** — React frontend with SSE streaming, workflow events, and conversation management
- **Pino structured logging** replacing console.log across all packages (#388)
- **Project-centric `~/.archon/` layout** — workspaces organized by `owner/repo` (#382)
- **Session deactivation reasons** stored in database for audit trail (#303, #385)
- **Remote branch cleanup** when PR is merged
- **Workflow log duration, tokens, and validation events** (#417)
- **Save-task-list command** for persisting task lists across sessions

### Changed

- `~/.archon/` restructured to project-centric layout (#382)
- Database command templates deprecated in favor of filesystem commands (#425)
- SQLite-first documentation with Postgres as optional (#418)
- `transitionSession` wrapped in database transaction for atomicity (#408)
- Codex SDK bumped to 0.101.0

### Fixed

- `.env` resolution in worktrees with credential error guidance (#404)
- CLI picking up `DATABASE_URL` from target repo `.env` (#389)
- PRs targeting wrong base branch instead of configured one (#387)
- Client error handling and GitHub self-triggering (#223, #240, #407)
- Handler bugs: JSON parsing, dotenv worktree, error messages (#392-#395, #406)
- Model selection and Codex options wiring (#428)
- SQLite busy timeout to prevent database locks (#418, #420)
- Workflow load errors and router failures surfaced to users (#410)
- WorkflowInvoker crash from workflows API type mismatch (#436)
- `getCodebaseCommands()` returning mutable reference (#379, #384)

## [0.2.4] - 2026-02-05

SQLite as default database and simplified CLI setup.

### Added

- **SQLite as default database** — zero-config setup with `~/.archon/archon.db`, no PostgreSQL required
- **Simplified CLI setup** — streamlined first-run experience on macOS/Linux

### Fixed

- Combined SQL schema syntax error (extra comma)
- Post-install configuration for Ubuntu VPS deployments

## [0.2.3] - 2026-01-31

Archon CLI skill, workflow routing improvements, and configuration fixes.

### Added

- **Archon CLI skill** for Claude Code — run workflows from within Claude Code sessions (#331, #332, #333)
- **Interactive setup wizard** and config editor for the Archon skill
- **`/workflow run` command** for direct workflow invocation from CLI
- **`archon-plan-to-merge` workflow** for end-to-end plan execution (#346)
- **Workflow error visibility** — `/workflow list` and `/workflow reload` show per-file load errors (#260, #263, #264)
- **Case-insensitive workflow routing** — router falls back to case-insensitive match (#263)

### Changed

- Workflow artifacts standardized with workflow-scoped paths (#352)
- Resilient workflow loading — one broken YAML no longer aborts loading all workflows (#260)
- `baseBranch` config option wired up for worktree creation (#330, #334)

### Fixed

- Config parse errors surfaced to users instead of silently failing (#284, #286)
- Workflow router prioritizes user intent over context (#365)
- Issue context passed to workflows for non-slash commands (#215)
- Cross-platform path splitting for worktree isolation (#245)
- WorktreeProvider error handling and silent failures (#276)
- Router error feedback with available workflow names (#263)
- Metadata serialization failure when `github_context` present (#262)
- Consecutive unknown errors tracked in workflow executor (#259)
- Thread inheritance error handling with logging and tests (#269)
- Isolation environments partial index replaces full unique constraint (#239)

## [0.2.2] - 2026-01-22

Documentation improvements and bug fixes.

### Added

- **CLI documentation** - User guide and developer guide with architecture diagrams (#326)
- **Private repo installation guide** using `gh` CLI for authenticated cloning
- **Manual release process** documentation for when GitHub Actions unavailable

### Changed

- **Repository ownership** migrated from `raswonders` to `dynamous-community`

### Fixed

- Dockerfile monorepo workspace structure for proper package resolution

## [0.2.1] - 2026-01-21

Server migration to Hono and CLI binary distribution infrastructure.

### Added

- **CLI binary distribution** - Standalone binaries for macOS/Linux with curl install and Homebrew formula (#325)
- **Bundled defaults** - Commands and workflows embedded at compile time for binary builds (#325)
- **Runtime default loading** - Load default commands/workflows at runtime instead of copying on clone (#324)
- **Default opt-out** - Config options `loadDefaultCommands` and `loadDefaultWorkflows` (#324)
- **Version command enhancements** - Shows platform, build type (binary/source), and database type (#325)

### Changed

- **Express to Hono migration** - Replaced Express with Hono for improved performance and Bun integration (#318)
- **Default port** changed from 3000 to 3090
- **ESLint zero-warnings policy** enforced in CI (#316)
- **CLAUDE.md consolidation** - Removed duplications and streamlined documentation (#317)

## [0.2.0] - 2026-01-21

Monorepo restructure introducing the CLI package for local workflow execution.

### Added

- **Monorepo structure** with `@archon/core`, `@archon/server`, and `@archon/cli` packages (#311)
- **CLI entry point** with `workflow list`, `workflow run`, and `version` commands (#313)
- **Database abstraction layer** supporting both PostgreSQL and SQLite (#314)
- **SQLite auto-detection** - uses `~/.archon/archon.db` when `DATABASE_URL` not set (#314)
- **Isolation commands** - `isolation list` and `isolation cleanup` for worktree management (#313)

### Fixed

- Surface git utility errors instead of swallowing silently (#292)

## [0.1.6] - 2026-01-19

Provider selection and session audit trail.

### Added

- **Config-based provider selection** for workflows - choose Claude or Codex per workflow (#283)
- **Session state machine** with immutable sessions for full audit trail (#302)
- **Workflow status visibility** - track running workflows per conversation (#256)
- Codex sandbox/network settings and progress logging (#290)

### Changed

- Comprehensive isolation module code review (#274)

### Fixed

- Stale workspace: sync before worktree creation (#287)
- Add defaults subdirectory to command search paths (#289)

## [0.1.5] - 2026-01-18

Major stability release with comprehensive bug fixes and test coverage.

### Added

- **Worktree-aware automatic port allocation** for parallel development (#178)
- **GitHub thread history** - fetch previous PR/issue comments as context (#185)
- **Cloud deployment support** for `with-db` profile (#134)
- Integration tests for orchestrator workflow routing (#181)
- Concurrent workflow detection tests (#179)
- Comprehensive AI error handling tests for workflow executor (#176)

### Changed

- Deep orchestrator code review refactor (#265)
- Improve error handling and code clarity in server entry point (#257)

### Fixed

- Workflows should only load from `.archon/workflows/` (#200)
- PR worktrees use actual branch for same-repo PRs (#238)
- GitHub adapter parameter bug causes clone failures (#209)
- Auto-detect Claude auth when `CLAUDE_USE_GLOBAL_AUTH` not set (#236)
- Worktree provider cleans up branches when worktrees are deleted (#222)
- Extract port utilities to prevent test conflicts with running server (#251)
- Workflows ensure artifacts committed before completing (#203)
- Worktree creation fails when orphan directory exists (#208)
- Add logging to detect silent updateConversation failures (#235)
- Auto-sync `.archon` folder to worktrees before workflow discovery (#219)
- Consolidate startup messages into single workflow start comment (#177)
- Show repo identifier instead of server filesystem path (#175)
- Check for existing PR before creating new one (#195)
- Use empty Slack token placeholders in .env.example (#249)

## [0.1.4] - 2026-01-15

Developer experience improvements and worktree stability.

### Added

- **Auto-copy default commands/workflows** on `/clone` (#243)
- **Pre-commit hook** to prevent formatting drift (#229)
- **Claude global auth** - `CLAUDE_USE_GLOBAL_AUTH` for SDK built-in authentication (#228)

### Changed

- Update README with accurate command reference and new features (#242)

### Fixed

- Copy `.archon` directory to worktrees by default (#210)
- Stale workflow cleanup and defense-in-depth error handling (#237)
- Cleanup service handles missing worktree directories gracefully (#207)
- Worktree limit blocks workflow execution instead of falling back to main (#197)
- Bot self-triggering on own comments (#202)
- Remove unnecessary String() calls in workflow db operations (#182)

## [0.1.3] - 2026-01-13

Workflow engine improvements with autonomous execution and parallel steps.

### Added

- **Ralph-style autonomous iteration loops** for plan-until-done execution (#168)
- **Parallel block execution** for workflows - run multiple steps concurrently (#217)
- **Workflow router** with platform context for intelligent intent detection (#170)
- **Emoji status indicators** for workflow messages (#160)
- Tests for logger filesystem error handling (#133)

### Changed

- Make `WorkflowDefinition.steps` readonly for immutability (#136)

### Fixed

- Detect and block concurrent workflow execution (#196)
- RouterContext not populated for non-slash commands on GitHub (#173)
- Workflow executor missing GitHub issue context (#212)
- Skip step notification for single-step workflows (#159)
- Remove redundant workflow completion message on GitHub (#162)
- Add message length handling for GitHub adapter (#163)
- Use code formatting for workflow/command names (#161)

## [0.1.2] - 2026-01-07

Introduction of the YAML-based workflow engine.

### Added

- **Workflow engine** for multi-step AI orchestration with YAML definitions (#108)
- Improve workflow router to always invoke a workflow (#135)

### Changed

- Improve error handling in workflow engine (#150)

### Fixed

- Add ConversationLock to GitHub webhook handler (#142)
- Bot no longer responds to @mentions in issue/PR descriptions (#143)
- Copy git-ignored files to worktrees (#145)
- `/repo <name>` fails due to owner/repo folder structure mismatch (#148)
- Load workflows from conversation.cwd instead of server cwd (#149)
- Revert to Bun native YAML parser and add Windows CI (#141)
- Wrap platform.sendMessage calls in try-catch in executor (#132)
- Cloud database pooler idle disconnects gracefully (#118)

## [0.1.1] - 2025-12-17

Isolation architecture overhaul and Bun runtime migration.

### Added

- **Bun runtime migration** - replaced Node.js/npm/Jest with Bun (#85)
- **Unified isolation environment architecture** with provider abstraction (#87, #92)
- **Scheduled cleanup service** for stale worktree environments (#94)
- **Worktree limits** with user feedback (#98)
- **Force-thread response model** for Discord (#93)
- **Archon distribution config** and `~/.archon/` directory structure (#101)
- User feedback messages for GitHub worktree operations (#90)
- Required SDK options for permissions and system prompt (#91)
- Test coverage for PR worktree creation (#77)

### Changed

- Drop legacy isolation columns in favor of new architecture (#99)
- Use `isolation_env_id` with fallback to `worktree_path` (#88)

### Fixed

- Fork PR support in worktree creation (#76)
- Multi-repository path collision bug (#78)
- Status command displays `isolation_env_id` (#89)
- Worktree path collision for repos with same name (#106)

## [0.1.0] - 2025-12-08

Initial release of the Remote Agentic Coding Platform.

### Added

- **Platform Adapters**
  - Telegram adapter with streaming support and markdown formatting
  - Slack adapter with Socket Mode for real-time messaging (#73)
  - Discord adapter with thread support
  - GitHub adapter with webhook integration for issues and PRs (#43)
  - Test adapter for HTTP-based integration testing

- **AI Assistant Clients**
  - Claude Code SDK integration with session persistence
  - Codex SDK integration as alternative AI assistant

- **Core Features**
  - PostgreSQL persistence for conversations, codebases, and sessions
  - Generic command system with user-defined markdown commands
  - Variable substitution ($1, $2, $ARGUMENTS, $PLAN)
  - Worktree isolation per conversation for parallel development (#43)
  - Session resume capability across restarts

- **Workflow Commands** (exp-piv-loop)
  - `/plan` - Deep implementation planning with codebase analysis
  - `/implement` - Execute implementation plans
  - `/commit` - Quick commits with natural language targeting
  - `/create-pr` - Create PRs from current branch
  - `/merge-pr` - Merge PRs with rebase handling
  - `/review-pr` - Comprehensive PR code review
  - `/rca` - Root cause analysis for issues
  - `/fix-rca` - Implement fixes from RCA reports
  - `/prd` - Product requirements documents
  - `/worktree` - Parallel branch development
  - `/worktree-cleanup` - Clean up merged worktrees
  - `/router` - Natural language intent detection (#59)

- **Platform Features**
  - Configurable streaming modes (stream/batch) per platform
  - Platform-specific authorization (whitelist users)
  - Configurable GitHub bot mention via environment variable (#66)

- **Developer Experience**
  - ESLint 9 with flat config and Prettier integration
  - Jest test framework with mocks
  - Docker Compose for local development
  - Builtin command templates (configurable via LOAD_BUILTIN_COMMANDS)

### Fixed

- Shared worktree cleanup preventing duplicate removal errors (#72)
- Case-sensitive bot mention detection in GitHub adapter
- PR review to checkout actual PR branch instead of creating new branch (#48)
- Template commands treated as documentation (#35, #63)
- Auto-load commands in /clone like /repo does (#55)
- /status and /repos codebase active state inconsistency (#60)
- WORKSPACE_PATH configuration to avoid nested repos (#37, #54)
- Shorten displayed paths in worktree and status messages (#33, #45)
- Create worktrees retroactively for legacy conversations (#56)

### Security

- Use commit SHA for reproducible PR reviews (#52, #75)
- Add retry logic to GitHub API calls for transient network failures (#64)
