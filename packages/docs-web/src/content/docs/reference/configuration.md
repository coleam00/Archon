---
title: Configuration Reference
description: Full reference for Archon's layered configuration system including YAML config, environment variables, and streaming modes.
category: reference
area: config
audience: [user, operator]
status: current
sidebar:
  order: 6
---

Archon supports a layered configuration system with sensible defaults, optional YAML config files, and environment variable overrides. For a quick introduction, see [Getting Started: Configuration](/getting-started/).

## Directory Structure

### User-Level (~/.archon/)

```
~/.archon/
├── workspaces/owner/repo/  # Project-centric layout
│   ├── source/             # Clone or symlink -> local path
│   ├── worktrees/          # Git worktrees for this project
│   ├── artifacts/          # Workflow artifacts
│   └── logs/               # Workflow execution logs
├── workflows/              # Home-scoped workflows (source: 'global')
├── commands/               # Home-scoped commands (source: 'global')
├── scripts/                # Home-scoped scripts (runtime: bun | uv)
├── store/                  # File workflow data (store: files)
├── archon.db               # SQLite (store: database, no DATABASE_URL)
└── config.yaml             # Global configuration (optional)
```

Home-scoped `workflows/`, `commands/`, and `scripts/` apply to every project on the machine. Repo-local legacy/shared files at `<repoRoot>/.archon/{workflows,commands,scripts}/` override them by filename (or script name). Shared/grouped layouts support one subfolder; packaged workflows use exactly `workflows/<pack>/<workflow>/` with one YAML directly inside. Package-owned commands and scripts do not fall through across scopes. See [Global Workflows](/guides/global-workflows/) for details and dotfiles-sync examples.

### Repository-Level (.archon/)

```
.archon/
├── commands/       # Custom commands
│   └── plan.md
├── workflows/      # Workflow definitions (YAML files)
└── config.yaml     # Repo-specific configuration (optional)
```

## Configuration Priority

Settings are loaded in this order (later overrides earlier):

1. **Defaults** - Sensible built-in defaults
2. **Global Config** - `~/.archon/config.yaml`
3. **Repo Config** - `.archon/config.yaml` in repository
4. **Environment Variables** - Process-level overrides
5. **Per-user AI preferences** - Personal assistant, tiers, and aliases for the acting user
6. **Run config** - Sparse content selected for one fresh run
7. **Explicit run model bindings** - Repeatable `--model` or HTTP `tiers`/`aliases`, per named binding

New runs record their resolved Archon AI configuration at launch preparation: assistant, provider defaults, tiers, aliases, and model bindings. Resume and continuation reuse that record. New child runs inherit the parent's recorded AI base; existing children keep their own record. Editing configuration or user AI preferences affects new independent runs, not an existing run. The repo config in that record comes from the checkout the run was launched from, not from its worktree; see [Where a run reads `.archon/config.yaml`](#where-a-run-reads-archonconfigyaml). Detached launches record the same values before handing the run to a child process; queued resource starts record them before admission.

Adoption inherits the recorded AI configuration while the selected workflow still owns its graph and scripts. New model bindings or AI-bearing run config are rejected for this adoption. Supersession prepares fresh AI configuration. Older runs without a recorded configuration keep resolving from current configuration and their existing sparse run overrides.

Credentials are checked and delivered freshly. The AI record excludes credential material and provider-native settings and guidance: Claude setting sources, provider binary paths, Codex search and additional directories, and Copilot config directory, discovery, login selection, and logging remain live. Process-owned Pi environment and concurrency settings are also excluded. Non-AI runtime settings continue to load through the normal configuration path.

The last three layers exist only where their setting has a run-time consumer. Archon-managed GitHub and provider credentials remain protected and are injected after user-authored run environment values.

## Global Configuration

### Workflow store

Set `store: database` (the default) or `store: files` in `~/.archon/config.yaml`.
With database storage, omitting `DATABASE_URL` selects SQLite at `~/.archon/archon.db`.
File storage is CLI-only and creates no database file or SQL connection. The server
refuses it, and setting `DATABASE_URL` together with `store: files` fails at startup.
Store selection has no environment override and is not a repository setting.
See [Database and file storage](/reference/database/) for file layout, recovery and limits.

Create `~/.archon/config.yaml` for user-wide preferences:

```yaml
# Default AI assistant
defaultAssistant: claude # must match a registered provider (e.g. claude, codex)

# Assistant defaults
assistants:
  claude:
    model: sonnet
    settingSources:   # Which sources the Claude SDK loads (default: ['project', 'user'])
      - project       # Project-level <cwd>/.claude/ (CLAUDE.md, skills, commands, agents)
      - user          # User-level ~/.claude/ (CLAUDE.md, skills, commands, agents)
    # Optional: absolute path to the Claude Code executable. Compiled binaries
    # find the native installer's ~/.local/bin/claude without it.
    # Accepts the native binary (~/.local/bin/claude from the curl installer),
    # the npm-installed cli.js, or the npm platform-package directory
    # (e.g. @anthropic-ai/claude-code-win32-x64 — auto-expanded to claude/claude.exe).
    # In all modes: CLAUDE_BIN_PATH wins, then claudeBinaryPath.
    # Source/dev mode uses SDK resolution only when neither pin is set.
    # Invalid explicit pins fail instead of falling back.
    # claudeBinaryPath: /absolute/path/to/claude
  codex:
    model: gpt-5.6-terra
    modelReasoningEffort: medium
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo
    # codexBinaryPath: /absolute/path/to/codex  # Optional: Codex CLI path
    # toolFreeStructuredOutputModels: [glm-5.3]  # Optional: routes that reject tools + strict schema together

# Streaming preferences per platform
streaming:
  telegram: stream # 'stream' or 'batch'
  discord: batch
  slack: batch
  github: batch

# Chat routes for attention notices (global config only). The platform must be an
# installed chat plugin that declares the attentionNotices capability; destination is
# passed to the plugin unchanged. Route ids (platform:destination) appear in /api/health.
# attentionNotices:
#   - platform: slack
#     destination: C0123456789

# Server-wide conversation admission
# Precedence: default (10) < global YAML < MAX_CONCURRENT_CONVERSATIONS.
# Repository config cannot change this limit.
# Nonnumeric env values such as abc are ignored; 5abc is parsed as 5.
# Copied/generated .env files set MAX_CONCURRENT_CONVERSATIONS=10.
# Remove or comment out that assignment to use the YAML limit.
concurrency:
  maxConversations: 10
  # Optional install-wide cap on simultaneous provider attempts, by provider ID.
  # Pi also honors assistants.pi.maxConcurrent. See "Provider concurrency caps" below.
  # providers:
  #   pi: 1

# Live tool attention and the provider-limit wait are both on by default.
workflows:
  toolCallAttentionMs: 1800000  # 30 minutes; 0 disables tool-call advisories
  autoResumeOnQuotaReset: true  # false fails a run on a provider usage or rate limit instead

# Model tiers — optional cross-provider presets used by bundled workflows,
# custom workflows, direct chat (`large`), and title generation (`small`).
tiers:
  large: { provider: claude, model: opus }
  medium: { provider: codex, model: gpt-5.6-terra, effort: high }
  small: { provider: pi, model: minimax-m3 }

# Model aliases — custom refs. Project workflows can name one directly; a bundled
# workflow names one in a preference list that ends in a tier, such as the SDLC pack's
# '@implementer' or '@reviewer', so an unset alias falls back to that tier.
aliases:
  '@reasoning': { provider: claude, model: opus, effort: max }

```

The `tiers:` block above is no longer hand-edit-only -- you can also set the `small`/`medium`/`large` presets from the console **AI Settings** -> **Model Tiers** panel, or from the CLI with [`archon ai tier set`](/reference/cli/#ai). Connecting your own provider API key or subscription is covered in [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

These files are persistent layers. For one invocation, use repeatable [`workflow run --model <name>=<spec>`](/reference/cli/#workflow-run-name-message), [`workflow run --config <path>`](/reference/cli/#per-run-config-files), or the run API's inline `config`, `tiers`, and `aliases` fields. Each run layer is sparse and sits above user, repository, global, and built-in values without editing a persistent config file.

### How `assistants:` is validated

Every `assistants.<provider>` block is checked by that provider when the config loads, in both `~/.archon/config.yaml` and a repository `.archon/config.yaml`. A misspelled key, an unsupported value, or a wrong type stops the load with a message naming the file, the provider, the key, and the accepted values. A `--config` run layer is checked by the same provider parser, with one difference: settings that apply to the whole process, such as `assistants.pi.env` and `assistants.pi.maxConcurrent`, are accepted in a config file and refused in a run layer. Values the provider would have quietly discarded used to reach a run and be reported as the setting the node ran at:

```
Invalid assistants config in '/Users/you/.archon/config.yaml':
  'assistants.claude.settingSources.0': expected 'project' or 'user'.
```

`archon doctor` reports the same failure as the **Config files** check. To repair `~/.archon/config.yaml` through Archon, change the invalid value from the console settings; any other settings, `archon ai tier set`, or `archon ai alias set` change is refused until that value is fixed, because Archon validates the whole file before writing it. An `assistants:` entry for a provider this install has not registered is ignored, as before — there is no provider to validate it.

The other blocks, `tiers`, `aliases`, `workflows`, `streaming`, `attentionNotices` and `concurrency`, fail the same way when their own check refuses a value. So does a file that is not valid YAML, whose top level is not a map of settings, or that Archon cannot read. The failure names the file and stops startup, `archon doctor`, run starts, chat messages and workflow listings such as `archon workflow list`; Archon never loads the file with that block replaced by defaults. Only a missing file falls back: `~/.archon/config.yaml` is created from the template, and a missing repository config uses defaults.

## Provider concurrency caps

`concurrency.providers.<provider-id>: N` limits how many attempts against that provider run at once across every Archon process sharing this database: server, CLI, detached runs, chat, and title generation. There are no default database-wide caps. A provider without an entry has no admission cap unless Pi has `assistants.pi.maxConcurrent` configured. For Pi, the stricter of these two caps applies across plugin processes. Set a cap only when the provider cannot take more, such as a local model on one GPU or an account with a hard concurrency limit.

- **Attempts, not runs.** One attempt holds one slot from the moment the provider starts until its stream has closed. Retry backoff between attempts holds no slot. A rate limit is retried with backoff as before; it never lowers the cap.
- **Waiting.** An attempt that finds the cap full waits and checks again about once a second. Cancelling the run stops the wait without starting the attempt. Until queue visibility lands, a waiting node looks idle, and a wait longer than the node's `idle_timeout` ends the node like any other idle node.
- **Changes apply immediately.** The cap is re-read on every admission check, including by attempts already waiting. Lowering it blocks new attempts until enough running ones finish; running attempts are never cancelled.
- **Strict.** A key that is not a registered provider ID, a value that is not a positive integer, or a config file that cannot be parsed refuses every provider attempt with an error naming the problem, instead of silently running uncapped.
- **Process loss.** A slot belongs to the process that took it. When that process dies, the next admission on the same host releases the slot. A holder from another host is never released by time or guesswork: list it with `archon ai capacity` and, once you have verified that process is gone, release it with `archon ai capacity release <attempt-id>`. Hosts that share one PostgreSQL database need distinct hostnames. A recreated Docker container gets a new hostname unless the compose service sets `hostname:`, so holders left by the old container need an explicit release.

## Run-scoped configuration

Keep a reusable file such as `config.minimax.yaml` in a repository and select it only for runs that need it:

```yaml
assistant: pi
tiers:
  large: { provider: pi, model: minimax/MiniMax-M3 }
workflows:
  toolCallAttentionMs: 600000
env:
  BENCH_MODE: "1"
```

```bash
archon workflow run x \
  --config ./config.minimax.yaml \
  --model large=openai/gpt-5.6
```

The file changes only the keys it contains. The explicit model flag is the final layer, so the command above replaces the file's `large` binding and keeps the file or lower-layer `small`, `medium`, aliases, assistant defaults, and other settings.

Run config accepts settings whose consumers still execute after the run is dispatched: `assistant` or `defaultAssistant`, `assistants`, `tiers`, `aliases`, `workflows`, `docs.path`, and `env`. It fails before source capture, isolation, or execution when a key cannot truthfully apply at that point:

- `commands` and `defaults` already affected workflow and command discovery.
- `worktree` and `container` already affected isolation.
- `botName`, `streaming`, `paths`, and `concurrency` are process-scoped or have no per-run consumer.
- `recommendedWorkflows` is listing-only.
- `assistants.pi.env` and `assistants.pi.maxConcurrent` are install settings rather than per-run settings. Pi concurrency is enforced at host admission for process providers; bundled Pi also retains its in-process semaphore.

Unknown keys, unregistered providers, invalid effort values, and alias names without `@` also fail instead of being ignored. CLI accepts a local path; the HTTP run API accepts inline validated content and never a caller-selected server path.

Fresh runs seal the normalized layer before recording it. The sealed layer exposes its source label and configured key paths, not plaintext `env` or raw provider-default values. The separate launch AI record stores resolved profiles and credential-free provider defaults. A continuation restores that sealed layer without rereading the original file, and child workflows inherit it. Detached CLI launches also transfer the already-validated sealed layer to the child instead of rereading the caller's file. This is why `--config` cannot be supplied with `--resume`.

## Repository Configuration

Create `.archon/config.yaml` in any repository for project-specific settings:

```yaml
# AI assistant for this project (used as default provider for workflows)
assistant: claude

# Assistant defaults (override global)
assistants:
  claude:
    model: sonnet
    settingSources:  # Override global settingSources for this repo
      - project
  codex:
    model: gpt-5.6-terra
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: auto-detected from git when not set
  copyFiles:  # Optional: Gitignored files/dirs to copy into new worktrees.
              # Nothing is copied unless you list it here.
    - .env
    - .vscode               # Copy entire directory
    - plans/                # Local plans not committed to the team repo
  initSubmodules: true  # Optional: default true — auto-detects .gitmodules and runs
                        # `git submodule update --init --recursive`. Set false to opt out.
  postCreate:          # Optional: sequential setup commands for newly created checkouts
    - bun install --frozen-lockfile
    - ./scripts/seed-fixtures.sh
  postCreateTimeout: 300000  # Optional: timeout in ms for EACH command
  path: .worktrees      # Optional: co-locate worktrees with the repo at
                        # <repoRoot>/.worktrees/<branch> instead of under
                        # ~/.archon/workspaces/<owner>/<repo>/worktrees/.
                        # Must be relative; no absolute, no `..` segments.
  remote: origin        # Optional: git remote name for fetch/push. Auto-detected
                        # when omitted (origin if it exists, sole remote otherwise).

# Documentation directory
docs:
  path: docs  # Optional: default is docs/

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime

# Recommended workflows for this project (declared order = pin order in the UI)
# recommendedWorkflows:
#   - archon-ship
#   - archon-review
#   - archon-plan

# Per-project environment variables for workflow execution.
# Injected into workflow subprocess environments. For secrets, open Environment variables
# from the project row in the console project rail.
# env:
#   MY_API_KEY: value
#   CUSTOM_ENDPOINT: https://...

# Model tiers and aliases override global entries with the same name (repo > global).
# tiers:
#   small: { provider: codex, model: gpt-5.6-luna }
# aliases:
#   '@fast': { provider: claude, model: haiku }

```

Only `claude` and `codex` ship built-in tier defaults (claude: `haiku`/`sonnet`/`opus`;
codex: the current small/medium/large models) and work without a `tiers:` block, at the
provider's default reasoning effort. Every other provider must configure each tier it
uses — with `archon ai tier set`, the console AI Settings -> Model Tiers panel, or the
`tiers:` block — or resolving `small`, `medium`, or `large` fails with a configuration
error that names those surfaces.

### Claude settingSources

Controls which sources the Claude Agent SDK discovers during sessions — `CLAUDE.md`, skills, commands, agents, and hooks. In workflow nodes, discovery does not activate ambient skills: the node's `skills:` list remains the exact active set, and omission/`[]` selects none.

A declared skill that is installed on disk must live under a source that remains
enabled — `settingSources: ['project']` cannot select a user-global skill, for
instance — and Archon rejects that mismatch before provider spend. Names that are
absent from disk entirely, such as Claude's built-in skills and plugin-qualified
`plugin:skill` entries, are left to the SDK to resolve. A plugin's skill loads only
when the node also names that plugin under `plugins:`.

Archon refuses a config file with an unrecognized entry such as
`settingSources: ['projct']`. Config that reaches the provider without that check
has only the unrecognized entry dropped, and logs `provider.config_invalid_fields_dropped`.
A typo therefore narrows the sources and reports itself, instead of falling back to
the permissive `['project', 'user']` default.

| Value | Description |
|-------|-------------|
| `project` | Load project-level `<cwd>/.claude/` (CLAUDE.md, skills, commands, agents) |
| `user` | Load user-level `~/.claude/` (CLAUDE.md, skills, commands, agents) |

**Default**: `['project', 'user']` — both project-level and user-level sources are loaded.

To restrict a project to project-level resources only (e.g. CI, shared environments, or when `~/.claude/` contains personal commands you don't want surfacing in workflows):

```yaml
assistants:
  claude:
    settingSources:
      - project
```

Set in `~/.archon/config.yaml` (global) or `.archon/config.yaml` (repo-specific).

### Where a run reads `.archon/config.yaml`

A new run reads `.archon/config.yaml` from the checkout it was launched from, live, including uncommitted and gitignored edits. The run still gets its own worktree for code; only the source of its config differs. The launch checkout is:

- **Foreground CLI:** the directory you run the command in, or `--cwd` when given. That can be the main checkout or a linked worktree. A `--branch` run that reuses an existing worktree still reads the launch checkout, not that worktree.
- **`archon workflow run --detach`:** the same directory. The launching process records the config before it hands the run to the background process.
- **Web, chat, and background dispatch:** the project's registered checkout path, even when the conversation already sits in a worktree from an earlier run. Adopting a run's worktree reads that worktree instead.
- **Queued resource starts** (triggers and forge sources): the launch path recorded when the start was queued. The config is recorded at that point, before admission.

The run records the resolved AI configuration (assistant, provider defaults, tiers, aliases, and model bindings) at launch. Resume, approve, reject, child runs, and adoption reuse that record, so later edits to `.archon/config.yaml`, in your checkout or in the run's worktree, do not change a run already started. An adopted run whose prior run has no record reads the adopted worktree or branch instead.

Some repo settings are read at launch from fixed places rather than the launch checkout:

- **`worktree.*`** (`baseBranch`, `remote`, `path`, `copyFiles`, `initSubmodules`, `postCreate`, `postCreateTimeout`) is read from the project's registered checkout when Archon creates the worktree. Registration also reads `worktree.remote` from the checkout being registered to select its remote, even for runs using `--no-worktree`.
- **Workflow-source settings** (`defaults.loadDefaultWorkflows`, `defaults.loadDefaultCommands`, `commands.folder`) are read from the source directory when the run captures its source (`--workflow-source` on the CLI), and are recorded with that capture.

To change the configuration a run uses:

- **Edit `.archon/config.yaml` before launching.** Committing is not needed; the launch reads your working tree.
- **A running run keeps its launch config.** To use new config, start a new run, or use `archon workflow run --supersedes <run-id>` to replace a finished one with fresh config.
- **Use `--config <file>`** for a one-off layer on a fresh run. It covers the settings listed in [Run-scoped configuration](#run-scoped-configuration).

### Worktree provisioning

`worktree.postCreate` runs sequentially through `bash -c` in the new worktree root, after submodule initialization and `copyFiles`, before the checkout becomes available. It also runs when Archon creates a checkout of an existing branch. Reusing or adopting a checkout already on disk skips provisioning. Commands use ordinary shell expansion; workflow variables and node outputs are unavailable. Put setup logic in a script.

Each command has a timeout of `worktree.postCreateTimeout` milliseconds (default `300000`) and receives empty stdin. POSIX setup has no controlling terminal, so commands cannot prompt through `/dev/tty`. On macOS and Linux each command owns a process group. Archon ends the whole group at the timeout, when the command exits (success included), or when its owning Archon process ends, including Ctrl-C, detached-owner cancel/abandon, server exit, and SIGKILL. Background jobs in that group are ended too. Archon confirms the group is gone before completing setup or reporting failure for rollback. A process that starts its own session or group (`setsid`, a daemon), or a service started outside the group (`docker compose up -d`), escapes this cleanup. Use setup to provision a checkout, not to leave a server running.

On Windows the timeout uses `taskkill /T /F` to end the tree still attached to the command at that moment. Descendants whose parent already exited can be missed, and command exit does not end background jobs. Redirect their output so they do not hold setup's output pipes open. Windows owner-stop paths retain their existing tree/console behavior; there is no POSIX stdin lifeline.

The first nonzero exit, timeout, spawn error, unconfirmed group termination, or audit-write failure aborts creation. The error includes the command and captured output with known credentials redacted. Cleanup removes only a clean checkout owned by this attempt; installer output or other changes may leave it locked. Inspect the reported path before unlocking or removing it. A worktree does not sandbox commands or undo external side effects. Cooperative cancel while a foreground or server owner remains alive does not interrupt setup; cancelling a pending run remains unsupported.

Setup uses the same host subprocess environment as `bash:` nodes: the cleaned host environment plus effective run configuration and managed project variables. Project variables override file-config values; run credential restrictions remain in force. Archon does not automatically load the target repository's `.env`, including one copied by `copyFiles`. A setup script can explicitly source it.

Started, completed, and failed commands appear in the run audit trail and `workflow logs`. Child setup is recorded on the parent run with the spawning node and child index. Manual worktree creation has no workflow run and writes structured application logs instead.

### Worktree file copying (`worktree.copyFiles`)

`git worktree add` only copies **tracked** files into a new worktree. Anything gitignored — secrets, local planning docs, agent reports, IDE settings, data fixtures — is absent by default. Archon's `worktree.copyFiles` closes that gap: after the worktree is created, each listed path is copied from the canonical repo into the worktree via raw filesystem copy (not git), so gitignored content comes along for the ride.

**Why this matters for agent runs.** A run does its work inside the worktree, so anything the agent needs at runtime has to be there. `.env` is the common case: without it an agent cannot start the project's server, run an integration test, or reproduce a bug that reads local credentials — and nothing errors, it simply finds no configuration. If you want agents to verify their own work by running the thing they changed, list `.env` here.

Copy the **real** gitignored file, never a tracked template. Listing `.env.example` is wrong twice over: the worktree already has it, because it is tracked; and materialising it as `.env` produces placeholder credentials, so a server starts misconfigured instead of failing loudly.

`worktree.copyFiles` is read from the repo's own `.archon/config.yaml`. It is not a global setting — placing it in `~/.archon/config.yaml` parses without error and has no effect.

**Nothing is copied unless you list it.** Archon used to copy `.archon/` into every worktree automatically, because that was the only way a workflow's own commands and scripts could be found from inside the worktree it was running against. Runs now carry their own source (see below), so the implicit copy is gone.

If you relied on it for a gitignored `.archon/config.yaml` holding local settings, list that file explicitly:

```yaml
worktree:
  copyFiles:
    - .archon/config.yaml
```

Copy only gitignored files this way. Copying a **tracked** file overwrites the version the worktree checked out, so if the two differ the worktree starts with an uncommitted change in its `git status`, and an agent that commits everything commits it too. Listing all of `.archon` has the same effect on its tracked workflows, commands, and scripts.

You do **not** need this for workflows, commands, or scripts. Those are captured by the run itself, including uncommitted ones. `.archon/config.yaml` is not part of that capture, but a new run's AI configuration is read from the checkout it was launched from, not from the worktree, so uncommitted and gitignored config applies without copying. See [Where a run reads `.archon/config.yaml`](#where-a-run-reads-archonconfigyaml).

**Workflow source no longer travels through the worktree.** When a run starts, Archon freezes the workflow's own `.archon/workflows`, `.archon/commands`, and `.archon/scripts` — plus your home-scoped `~/.archon/` source, so a statically included global workflow is frozen too — into a separate source capture beside that run's artifacts, at `~/.archon/workspaces/<project>/workflow-source/runs/<run-id>/`. It resolves frozen source from there throughout the run; `$ARTIFACTS_DIR` remains the output channel. See [workflow source capture](/reference/cli/#running-a-workflow-from-another-checkout). Three consequences:

- The worktree stays clean. Authoring files never appear in its `git status`, and repo validators no longer see packages that came from somewhere else.
- Editing or deleting the authoring checkout mid-run does not change a run already in flight. A resumed run executes the source it started with; the next fresh run picks up your edits.
- Uncommitted workflows work against any target, with no commit, push, or merge — see `--workflow-source` in the [CLI reference](/reference/cli/).

**Common entries:**

```yaml
worktree:
  copyFiles:
    - .env                  # local secrets
    - .vscode/              # editor settings
    - .claude/              # per-repo Claude Code config (agents, skills, hooks)
    - plans/                # working docs that aren't committed
    - reports/              # agent-generated markdown reports
    - data/fixtures/        # local-only test data
```

**Semantics:**

- Each entry is a path (file or directory) relative to the repo root — source and destination are always identical. No rename syntax.
- Missing files are silently skipped (`ENOENT` at debug level), so you can list "optional" entries without bookkeeping.
- Directories are copied recursively.
- Per-entry failures are isolated — one bad entry won't abort the rest. Non-ENOENT failures (permissions, disk full) are surfaced as warnings on the environment.
- Path-traversal attempts (entries resolving outside the repo root, or absolute paths on a different drive) are rejected — the entry is logged and skipped.

**Interaction with `worktree.path`:** The copy step runs identically (and is still a no-op with no `copyFiles`) whether worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/` (default) or inside the repo at `<repoRoot>/<worktree.path>/` (repo-local). Both layouts get the same gitignored-file treatment.

**Defaults behavior:** The app's bundled default commands and workflows are loaded at runtime and merged with repo-specific ones. Repo commands/workflows override app defaults by name. Set `defaults.loadDefaultCommands: false` or `defaults.loadDefaultWorkflows: false` to disable runtime loading.

**Submodule behavior:** When a repo contains `.gitmodules`, submodules are initialized in new worktrees by default (git's `worktree add` does not do this). Repos without submodules skip this step. Submodule init failure throws a classified error (credentials, network, timeout). The incomplete checkout stays locked for manual inspection because parent-repository status cannot prove that submodules contain no changes. The error names the leftover path. Inspect it and preserve any changes, then finish any needed setup and run `git worktree unlock <path>` for reuse, or remove the checkout. Checkouts with index flags that can hide changes are also preserved when setup fails. Set `worktree.initSubmodules: false` to opt out.

**Remote behavior:** By default, all git operations (fetch, push, branch tracking) use the `origin` remote. If your repo uses a different remote name, configure `worktree.remote`. Resolution order:
1. If `worktree.remote` is set: Uses the configured remote name for all operations.
2. If omitted: Auto-detects — `origin` if it exists, otherwise the sole remote if only one is configured.
3. If multiple remotes exist and none is named `origin`: Worktree creation **fails with an actionable error** listing the available remotes and suggesting the config fix. Registration still succeeds but records no repository URL, unless one of the remotes already belongs to a registered project, which refuses it as a second clone. A project registered this way owns none of its remotes, so a later clone of one of them registers as a separate project; set `worktree.remote` before registering to avoid that.

**Base branch behavior:** Before creating a worktree, the canonical workspace is synced to the latest code. Resolution order:
1. If `worktree.baseBranch` is set: Uses the configured branch. **Fails with an error** if the branch doesn't exist on the resolved remote (no silent fallback).
2. If omitted: Uses the project's stored explicit branch, if present; otherwise resolves the default from the remote's live HEAD advertisement. Renames are followed even when local remote HEAD is stale. A reachable remote with a known symbolic HEAD is required; no branch name is guessed.
3. If a workflow references `$BASE_BRANCH` while its base is unresolved, the node fails. See [`$BASE_BRANCH` fail-fast](/reference/variables/#base_branch-fail-fast) for causes and recovery.

**Docs path behavior:** The `docs.path` setting controls where the `$DOCS_DIR` variable points. When not configured, `$DOCS_DIR` defaults to `docs/`. Unlike `$BASE_BRANCH`, this variable always has a safe default and never throws an error. Configure it when your documentation lives outside the standard `docs/` directory (e.g., `packages/docs-web/src/content/docs`).

### Recommended workflows (`recommendedWorkflows`)

Repo owners curate an **ordered list of recommended workflows** in the project's
`.archon/config.yaml`. The console's new-run picker shows that ordered list under
**Recommended for this project** and the remaining choices under **Other workflows**.

```yaml
recommendedWorkflows:
  - archon-ship
  - archon-review
  - archon-plan
```

**Semantics:**

- **List order = pin order.** First entry appears first in both UIs.
- Each entry is a **workflow name** matched against the discovered set (bundled + global + project).
- A name that matches **no** discovered workflow is **silently ignored** (debug log). The list is advisory — a stale entry never breaks discovery.
- Search and category filters apply to **both** partitions. If filtering hides all recommended cards, the header is not rendered.
- Key **absent or empty** → flat list, no header, no divider. Zero-config safe.
- The list lives **per-project only** — it is not part of global config (`~/.archon/config.yaml`) and is not per-user.

**Worktree path behavior:** By default, every repo's worktrees live under `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>` — outside the repo, invisible to the IDE. Set `worktree.path` to opt in to a **repo-local** layout instead: worktrees are created at `<repoRoot>/<worktree.path>/<branch>` so they show up in the file tree and editor workspace. A common choice is `.worktrees`. Because worktrees now live inside the repository tree, you should add the directory to your `.gitignore` (Archon does not modify user-owned files). The configured path must be relative to the repo root; absolute paths and paths containing `..` segments fail loudly at worktree creation rather than silently falling back.

### Container isolation (folder projects)

**Folder projects** run in place by default. Opt into overlay-isolated Docker execution — writes land in an overlay upper layer, not the live root — with the `--container` CLI flag, the `container.enabled` config key, or a workflow's `container.enabled` policy. Valid on both global and repo `.archon/config.yaml` (repo overrides global per-field):

```yaml
container:
  image: archon-runner:latest # runner image tag (default: archon-runner:latest)
  network: bridge # 'bridge' (default) or 'none' (no egress)
  memoryMb: 4096 # hard memory cap in MiB (positive integer)
  pidsLimit: 512 # process cap / fork-bomb guard (positive integer)
  enabled: false # run folder projects in a container without --container (default false)
```

**Selection precedence:** `--container` flag > workflow `container.enabled` > config `container.enabled` > `false`. (A workflow `enabled: false` hard-disables relative to config, but the flag still wins.)

**Write-back mode** is a per-workflow policy (not a config key). After a container run finishes, its overlay diff is reviewed before touching the live root:

```yaml
# In a workflow YAML (.archon/workflows/*.yaml):
container:
  write_back: approve # 'approve' (default) pauses at a write-back gate; 'auto' applies without pausing
```

**Prerequisites:** Docker, and the runner image built with `bun run build:runner-image` (tags `archon-runner:<version>` + `:latest`). Rebuild existing and custom runner images after upgrading Archon: native fallback requires the current entrypoint's dedicated FUSE mount failure status (78). Docker startup failures, including a missing `/dev/fuse`, and older images returning a generic failure status stop preparation without native fallback. Container mode is **folder-project-only** (a repo project errors). Pausing workflows (approval/interactive gates) **are** supported — a normal gate pause `docker stop`s the container (near-zero resources once stopped) and resume rediscovers and restarts it. Failed resume setup marks the run failed. Failed setup or suspension can leave its container running and consuming resources; see [Pause economics](/guides/container-isolation/#pause-economics). `$ARTIFACTS_DIR` is bound read-write at its host path; `$STATE_DIR` is not mounted — see [Container runs and run output](#container-runs-and-run-output) below. For the full flow, pause economics, and security posture, see the [Container isolation guide](/guides/container-isolation/) and `packages/isolation/docker/SECURITY.md`.

### Container runs and run output

Standard CLI container runs bind `$ARTIFACTS_DIR` read-write at the same absolute path
inside the container and on the host. Write screenshots, reports, and other run output
there: they are available in the host run's artifacts directory without project write-back
and survive container teardown.

The project root is mounted read-only at `/mnt/lower`, and the per-run overlay volume at
`/mnt/upper` holds project changes until write-back. The run's frozen workflow source is
also bound at its host path, read-only. Archon does not mount all of `ARCHON_HOME`.

`$STATE_DIR` is not mounted. Files written there inside the container stay in its ephemeral
layer and disappear when the container is removed. Use `$ARTIFACTS_DIR` for host-visible
run output; use the project working directory for changes that should pass through the
overlay diff and write-back gate.

On rootful Linux daemons, artifact files are initially owned by the container's root user.
Archon attempts to restore host ownership when suspending or destroying the container.
This is best-effort: failures are logged as `isolation.container_artifacts_chown_failed`
and do not stop suspension or destruction. Older resumed runs whose metadata predates the
artifacts bind retain container-local artifact output;
Archon logs `isolation.container_resume_without_artifacts_mount` when recreating them.

## Environment Variables

Environment variables override all other configuration. They are organized by category below.

### Core

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_HOME` | Base directory for all Archon-managed files. **Ignored in Docker** — the container always uses `/.archon`. | `~/.archon` |
| `PORT` | HTTP server listen port | `3090` (auto-allocated in worktrees) |
| `LOG_LEVEL` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). Read from the environment or from `~/.archon/.env` or `.archon/.env`. CLI commands other than `archon serve` log at `warn` unless `--verbose` or `LOG_LEVEL=debug`/`trace` is set (a quieter `LOG_LEVEL` such as `error` is kept); see [CLI logs](/reference/cli/#logs). At `debug` or `trace`, each DAG run compares the usage totals it writes to the run with the sum of its node events, and logs `dag.run_usage_reconciliation_mismatch` with both figures when they differ. | `info` |
| `BOT_DISPLAY_NAME` | Bot name shown in batch-mode "starting" messages | `Archon` |
| `DEFAULT_AI_ASSISTANT` | Fallback AI assistant when no config file sets the assistant. Overridden by `defaultAssistant` in global config or `assistant` in repo config. Must match a registered provider id. | Only registered provider, otherwise unset |
| `MAX_CONCURRENT_CONVERSATIONS` | Maximum concurrent AI conversations | `10` |
| `SESSION_RETENTION_DAYS` | Delete inactive sessions older than N days. Must be a positive integer; invalid values stop startup. | `30` |
| `ARCHON_VERBOSE_BOOT` | When set to `1`, prints `[archon] loaded N keys from …` lines to stderr at boot. Also enabled by `LOG_LEVEL=debug` or `LOG_LEVEL=trace`. Silent by default to avoid interleaving with interactive command output. | -- |
| `ARCHON_BASH_PATH` | Override the bash executable path used by `bash` nodes and loop `until_bash`. Eagerly validated at resolution time — typos surface immediately instead of as opaque ENOENTs inside the first bash-node fire. | `bash` on Linux/macOS; on Windows, the first existing of the common Git-Bash locations: `%ProgramFiles%\Git\bin\bash.exe`, `%ProgramFiles%\Git\usr\bin\bash.exe`, `%ProgramFiles(x86)%\Git\bin\bash.exe`, `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`, `%USERPROFILE%\scoop\apps\git\current\bin\bash.exe` |
| `WSL_DISTRO_NAME` | Set automatically by WSL in every distro shell. Archon reads it (via `/api/health`) to emit Windows-host-friendly `vscode://vscode-remote/wsl+<distro>/...` "Open in IDE" URIs. You do not normally set this yourself; override it only to force a specific distro name into the URI. | -- (unset outside WSL) |

### AI Providers -- Claude

| Variable | Description | Default |
| --- | --- | --- |
| `CLAUDE_USE_GLOBAL_AUTH` | Startup-check marker: `true` tells the server you rely on a `claude /login` session. Claude Code never reads it. | Set to `true` by the CLI, and by the server unless `TOKEN_ENCRYPTION_KEY` is set, when no token or key is set |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token from `claude setup-token` | -- |
| `CLAUDE_API_KEY` | Anthropic API key. Passed to Claude Code as `ANTHROPIC_API_KEY` when neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` is set | -- |
| `TITLE_GENERATION_MODEL` | Lightweight model for generating conversation titles | SDK default |
| `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` | Timeout (ms) before Claude subprocess is considered hung (throws with diagnostic log) | `60000` |

Claude Code uses a token or key from its environment when one is set, and its own `claude /login` session otherwise, whatever `CLAUDE_USE_GLOBAL_AUTH` says. A fresh Docker container has no login session, so set a token or key there.

### AI Providers -- Codex

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_CODEX_ID_TOKEN` | Codex ID token (from `~/.codex/auth.json`) | -- |
| `ARCHON_CODEX_ACCESS_TOKEN` | Codex access token | -- |
| `ARCHON_CODEX_REFRESH_TOKEN` | Codex refresh token | -- |
| `ARCHON_CODEX_ACCOUNT_ID` | Codex account ID | -- |
| `CODEX_API_KEY` | Run Codex on this OpenAI API key instead of the login in your Codex home. Held in the Codex process's memory, never written to `CODEX_HOME`. Codex does not read `OPENAI_API_KEY`. | -- |

### AI Providers -- Copilot (community)

| Variable | Description | Default |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | Explicit GitHub PAT for the Copilot provider. Always wins over `useLoggedInUser` when set. | -- |
| `COPILOT_BIN_PATH` | Absolute path to the Copilot CLI binary. Required in compiled Archon binaries when `assistants.copilot.copilotCliPath` is not set; auto-detected in dev mode. | -- |

The Copilot provider also reads `assistants.copilot.{model, modelReasoningEffort, copilotCliPath, configDir, enableConfigDiscovery, useLoggedInUser, logLevel}` from `~/.archon/config.yaml` or `.archon/config.yaml`. See the [AI Assistants guide](/getting-started/ai-assistants/) for the full setup.

### Platform Adapters -- Slack

These variables configure the `chat-slack` plugin. In Docker, a nonempty `SLACK_BOT_TOKEN` declares installation of the image-provided release offline at startup; both tokens are required to connect. Existing installed releases are retained. Remove the tokens from every effective env source and remove the plugin to keep Slack off across Docker restarts. Outside Docker, install the plugin manually. See the [Slack guide](/adapters/slack/).

| Variable | Description | Default |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) | -- |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode (`xapp-...`) | -- |
| `SLACK_ALLOWED_USER_IDS` | Comma-separated Slack user IDs for whitelist | Open access |
| `SLACK_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `batch` |

### Platform Adapters -- Telegram

| Variable | Description | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | -- |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs for whitelist | Open access |
| `TELEGRAM_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `stream` |

### Platform Adapters -- Discord

| Variable | Description | Default |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token from Developer Portal | -- |
| `DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user IDs for whitelist | Open access |
| `DISCORD_STREAMING_MODE` | Streaming mode (`stream` or `batch`) | `batch` |
| `DISCORD_REQUIRE_MENTION` | Require @mention to activate in servers (`true` or `false`); DMs never require a mention | `true` |

### Platform Adapters -- GitHub

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | Required with `WEBHOOK_SECRET` to activate the GitHub adapter in PAT mode. Used for adapter API calls, cloning and forge credentials when `GH_TOKEN` is unset or empty. | -- |
| `GH_TOKEN` | Preferred token for adapter API calls in PAT mode, cloning, forge credentials and the GitHub CLI. Takes precedence over `GITHUB_TOKEN`; does not activate the adapter by itself. | -- |
| `GITHUB_URL` | Base URL of a GitHub Enterprise Server (e.g. `https://github.example.com`). The adapter and the GitHub App call `<GITHUB_URL>/api/v3`, and HTTPS clones with this exact scheme, host and port use `GH_TOKEN`/`GITHUB_TOKEN` (or the App's installation token in App mode). A value that is not a bare `http(s)://host[:port]` URL fails startup. See [GitHub Enterprise Server](/adapters/github/#github-enterprise-server). | github.com |
| `WEBHOOK_SECRET` | HMAC SHA-256 secret for GitHub webhook signature verification | -- |
| `GITHUB_ALLOWED_USERS` | Comma-separated GitHub usernames for whitelist (case-insensitive) | Open access |
| `GITHUB_BOT_MENTION` | @mention name the bot responds to in issues/PRs | Falls back to `BOT_DISPLAY_NAME` |

### Per-user GitHub identity (App mode, optional)

An opt-in layer on top of [GitHub App mode](/adapters/github-app-setup/) that lets each teammate connect their own GitHub identity so workflow commits name the human as author while keeping the ambient Git identity as committer. PR comments and pushes use the connected user's identity. The feature gate turns on when `GITHUB_APP_ID` **and** `TOKEN_ENCRYPTION_KEY` are both set; `GITHUB_APP_CLIENT_ID` is additionally required for the connect (device) flow — set all three. Solo `GITHUB_TOKEN` installs and App-for-bot-only installs are unaffected.

| Variable | Description | Default |
| --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | The App's **Client ID** (starts with `Iv1.`/`Iv23…`, distinct from the numeric `GITHUB_APP_ID`). Required for the device flow that connects per-user identities. | -- |
| `TOKEN_ENCRYPTION_KEY` | 64-char hex (32 bytes; `openssl rand -hex 32`) used to encrypt stored per-user tokens at rest (AES-256-GCM). **Per-user GitHub identity** requires this + `GITHUB_APP_ID`. **AI credential vault** auto-provisions its own key at `~/.archon/credential-key` — this env var overrides that file on managed/multi-user deploys. **Rotating it invalidates all stored user credentials** — everyone must reconnect. | -- |
| `ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK` | When `false` (default), a workflow run by an **unconnected** user has `GH_TOKEN`/`GITHUB_TOKEN` scrubbed (so `gh`/`git` fail) rather than silently using the shared org/bot token. Set `true` to opt back into the shared token. | `false` |
| `ARCHON_WEB_AUTH_HEADER` | Name of the reverse-proxy-set header Archon trusts to identify the web user (reverse-proxy fallback; still honored alongside Better Auth web login below). Only safe when Archon is reachable **solely** through a trusted proxy that strips client-supplied values and sets the header from the authenticated identity. Use a loopback bind for a same-host proxy or a private container interface for a container proxy; clients must not be able to reach the upstream directly. See the [reverse-proxy contract](/deployment/reverse-proxy/#authentication-and-headers). Absent header → unattributed (never elevated). | `X-Archon-User` |

To connect once the vars are set: `archon auth github` (CLI) or the Web UI **Settings → Connect GitHub** card.

### Web UI login (Better Auth, optional)

Real per-user email/password login for the Web UI, mounted at `/api/auth/*` by [Better Auth](https://better-auth.com). **Opt-in and Postgres-only**: enabled only when **both** `DATABASE_URL` (Postgres) and `BETTER_AUTH_SECRET` are set. SQLite/solo installs can never enable it and behave exactly as before (no login UI). It supersedes the single-user `auth-service` sidecar; the `ARCHON_WEB_AUTH_HEADER` trust above remains a fallback for reverse-proxy deploys.

A Better Auth session resolves to the **canonical** `remote_agent_users` row via the `web` platform identity, so chat/CLI/forge identities and the `role` column live on the one Archon user — Better Auth is only the login mechanism. Better Auth owns four tables prefixed `remote_agent_auth_*` (`user`/`session`/`account`/`verification`), applied automatically on startup. Every web request resolves a `{ userId, role }` auth context (session first, then the trusted header); `role` is explicitly written as `member` for new users, while existing roles are preserved. The operator designates admins with [`archon user role <id> admin`](/reference/security/#users-and-roles); only a run's starter or an admin can act on it, while the local operator always remains allowed. See [Who can act on a run](/reference/security/#who-can-act-on-a-run). Web and CLI conversations are private to their owner; see [Adapter authorization](/reference/security/#adapter-authorization). Run reads stay open: `GET /api/workflows/runs?mine=true` is a non-enforcing "my" filter, not a security boundary.

| Variable | Description | Default |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Session signing secret, **≥32 chars** (`openssl rand -base64 32`). Its presence (with `DATABASE_URL`) is what enables web login. Boot fails fast if set but too short. | -- |
| `BETTER_AUTH_URL` | Public base URL. Omit for same-origin deploys (inferred from the request); set only behind a fixed-origin reverse proxy. | inferred |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated extra origins allowed for CSRF/cross-origin (beyond same-origin). | -- |
| `ARCHON_AUTH_ALLOWED_EMAILS` | Comma-separated invite allowlist for signup (case-insensitive). Set this to invite teammates. | -- |
| `ARCHON_AUTH_OPEN_SIGNUP` | `true` allows open public signup when no allowlist is set. Default (unset) + no allowlist = signup **disabled** (login only). | `false` |
| `ARCHON_WEB_AUTH_REQUIRED` | When web auth is enabled, gate every `/api/*` request server-side (401 without a session/identity), except `/api/auth/*` and `/api/health*`. `false` keeps login-UI-only. | on (when enabled) |

Signup uses email + password (no email verification by default). **Signup posture:** allowlist set → invite-gated (403 for non-listed emails); no allowlist + `ARCHON_AUTH_OPEN_SIGNUP=true` → open; otherwise **disabled** (login only, with a boot WARN) so enabling auth never silently opens public registration. Existing sessions remain valid until expiry even if an email is later removed from the allowlist. When `ARCHON_WEB_AUTH_REQUIRED` is on (default), Better Auth is the real access gate, so the Caddy `forward_auth` sidecar can be retired.

### Platform Adapters -- Gitea

| Variable | Description | Default |
| --- | --- | --- |
| `GITEA_URL` | Self-hosted Gitea instance URL (e.g. `https://gitea.example.com`) | -- |
| `GITEA_TOKEN` | Gitea personal access token or bot account token | -- |
| `GITEA_WEBHOOK_SECRET` | HMAC SHA-256 secret for Gitea webhook signature verification | -- |
| `GITEA_ALLOWED_USERS` | Comma-separated Gitea usernames for whitelist (case-insensitive) | Open access |
| `GITEA_BOT_MENTION` | @mention name the bot responds to in issues/PRs | Falls back to `BOT_DISPLAY_NAME` |

### Database

| Variable | Description | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string for `store: database` (omit to use SQLite; incompatible with `store: files`) | SQLite at `~/.archon/archon.db` under `store: database` |

### Web UI

| Variable | Description | Default |
| --- | --- | --- |
| `WEB_UI_ORIGIN` | CORS origin for API routes (restrict when exposing publicly) | `*` (allow all) |
| `WEB_UI_DEV` | When set, skip serving static frontend (Vite dev server used instead) | -- |

### Worktree Management

| Variable | Description | Default |
| --- | --- | --- |
| `STALE_THRESHOLD_DAYS` | Days before an inactive worktree is considered stale. Must be a positive integer; invalid values stop startup. | `14` |
| `MAX_WORKTREES_PER_CODEBASE` | Max worktrees per codebase before auto-cleanup | `25` |
| `CLEANUP_INTERVAL_HOURS` | How often the background cleanup service runs. Must be a positive integer from 1 to 596 (the runtime timer limit); invalid values stop startup. | `6` |

### Docker / Deployment

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_DATA` | Host path for Archon data (workspaces, worktrees, artifacts). Compose-only — read by `docker-compose.yml` to choose the bind-mount source for `/.archon`; not read by Archon source code. | Docker-managed volume |
| `ARCHON_USER_HOME` | Host path for `/home/appuser` (Claude/Codex/Pi config, `~/.gitconfig`, shell history). Compose-only — read by `docker-compose.yml` to choose the bind-mount source for `/home/appuser`; not read by Archon source code. Persisted by default to a Docker-managed volume so user state survives rebuilds. | Docker-managed volume |
| `DOMAIN` | Public domain for Caddy reverse proxy (TLS auto-provisioned) | -- |
| `CADDY_BASIC_AUTH` | Caddy basicauth directive to protect Web UI and API | Disabled |
| `AUTH_USERNAME` | Username for form-based auth (Caddy forward_auth) | -- |
| `AUTH_PASSWORD_HASH` | Bcrypt hash for form-based auth password (escape `$` as `$$` in Compose) | -- |
| `COOKIE_SECRET` | 64-hex-char secret for auth session cookies | -- |
| `AUTH_SERVICE_PORT` | Port for the auth service container | `9000` |
| `COOKIE_MAX_AGE` | Auth cookie lifetime in seconds | `86400` |

### Telemetry

Archon sends a few anonymous events — `archon_started` (once per CLI invocation or server boot), `archon_active` (daily server heartbeat), `chat_turn_handled` (direct chat turn — platform, provider, model, duration, and usage totals, counted as failed when the provider errors mid-turn; never message content), `workflow_no_match` (agent-reported no-fit count and transport only), `workflow_invoked` (workflow start or resumed segment), `workflow_completed`/`workflow_failed`/`workflow_cancelled` (sent once when the run's final status is saved), `workflow_approval_resolved` (binary approve/reject), and `codebase_registered` (pure count — no name/path/URL). Categorical only: workflow name (real for bundled workflows, `"custom"` for your own), platform, provider id (model id on `workflow_invoked`), node shape (`nodes_<type>` counts, `graph_depth`, `max_fan_out`, `command_refs`, `prompt_chars_bucket`) and feature flags, `derived_from`/`derived_similarity` naming the bundled workflow a custom one was copied from (never the copy's own name), outcome/duration, aggregate provider-reported usage (gross input, output, optional cache-read/cache-write totals plus a flag when those totals are a floor, cost, and loop iterations), a fixed-enum failure class and exit/cancel reason (never error text), a `run_ref` hash that joins one run's events without sending its id, deployment shape (adapter/db/auth booleans and a chat plugin count), OS/arch/version, install channel (`binary`/`docker`/`source`) and build commit, a `schema_version`, and a random install UUID stored at `$ARCHON_HOME/telemetry-id`. No code, prompts, paths, IP, geo, or error text. Any one of the variables below disables it. See `archon telemetry status` to inspect the live state.

| Variable | Description | Default |
| --- | --- | --- |
| `ARCHON_TELEMETRY_DISABLED` | Set to `1` to disable anonymous telemetry | -- |
| `DO_NOT_TRACK` | Set to `1` to disable telemetry (de facto standard honored by Astro, Bun, Prisma, etc.) | -- |
| `CI` | When set to `true` (case-insensitive), telemetry is auto-disabled so fork CI runs don't send events | -- |
| `POSTHOG_API_KEY` | Set to `off` / `0` / `false` / `disabled` / empty to disable; set to a `phc_*` key to use a custom PostHog project | Built-in key |
| `POSTHOG_HOST` | Custom PostHog instance URL (first failure on a custom host logs at `warn`) | `https://us.i.posthog.com` |

### `.env` File Locations

Archon loads its own environment files, separate from the target repository's app configuration. The CLI and compiled server load `.archon/.env` files at user and repo scope. A server running from source also loads the Archon checkout's root `.env`.

| Path | Stripped at boot? | Archon loads? | `archon setup` writes? |
| --- | --- | --- | --- |
| Target repo `<cwd>/.env` | **yes** (safety guard) | no | never |
| `<archon-checkout>/.env` | yes if the checkout is CWD | source server only, after stripping, without override | never |
| `<cwd>/.archon/.env` | no | yes (repo scope, overrides user scope with CLI exceptions below) | yes iff `--scope project` |
| `~/.archon/.env` | no | yes (user scope) | yes iff `--scope home` (default) |

**Load order at boot** (every entry point — CLI and server):

1. Strip every key named in `<cwd>/.env`, `.env.local`, `.env.development`, `.env.production`, including shell or direnv values with those names (prevents target-repo env from leaking into Archon).
2. **Source-checkout server only:** load `<archon-checkout>/.env` without `override`, so values still in the process environment win. This path is resolved from the server source location, independently of CWD. When CWD is the Archon checkout, this deliberately reloads its root `.env` after stripping. The CLI and compiled server skip this step.
3. Load `~/.archon/.env` with `override: true` (archon config wins over shell-inherited vars and source-checkout values).
4. Load `<cwd>/.archon/.env` with `override: true` (repo scope wins over user scope).

The CLI makes exceptions to this order: selected chat scope is read from the explicit `--chat-project-id` argument before Archon env loading; env files and the old `ARCHON_WORKFLOW_CODEBASE_ID` variable cannot supply or override it. Repository env cannot set `GH_CONFIG_DIR`; the CLI preserves the user-scope value, including its absence. Inside a workflow, an inherited `GH_CONFIG_DIR`, `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN`, including an empty value, wins over both files. The standalone server follows the general load order above, including repository overrides of `GH_CONFIG_DIR`. See [forge configuration](/reference/forge/#plugin-configuration) and [GitHub credentials](/reference/forge/#github-credentials-and-check-observations).

A repository's `<cwd>/.archon/.env` cannot set `ARCHON_HOME`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER`, `WORKSPACE_PATH` or `PATH`. If it does, Archon refuses to start and names the file and the key. Those keys decide which Archon home and which executables Archon uses, so a repository could otherwise choose which plugins run. Set them in your shell, your scheduler or `~/.archon/.env` instead.

**Operator log lines** (stderr, emitted only when there is something to report):

```
[archon] stripped 2 keys from /path/to/target-repo (.env, .env.local) to prevent target repo env from leaking into Archon processes
```

The `[archon] loaded N keys from …` lines are suppressed by default (they would otherwise interleave with `archon setup`/`archon doctor` checklist output). To enable them, set `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL=debug` before running:

```
[archon] loaded 3 keys from ~/.archon/.env
[archon] loaded 2 keys from /path/to/target-repo/.archon/.env (repo scope, overrides user scope)
```

**Which file should I use?**

- **`~/.archon/.env`** — user-wide defaults (your personal `SLACK_WEBHOOK`, `DATABASE_URL`, etc.). Applies to every project.
- **`<cwd>/.archon/.env`** — per-project overrides. Different webhook per repo, different DB per environment, etc. It cannot set `ARCHON_HOME`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER`, `WORKSPACE_PATH` or `PATH`.
- **Target repo `<cwd>/.env`** — **your app's** env file. Archon strips its keys at boot and does not load its values.
- **`<archon-checkout>/.env`** — configuration for a server running from Archon source, as described in the [developer guide](https://github.com/coleam00/Archon/blob/dev/CONTRIBUTING.md#getting-started). This is Archon's own checkout, not a separate target repository. Its root `.env` loads even when the server starts with another CWD; when the checkout itself is CWD, its root `.env` is the exception to the target-repo rule above.

```bash
# User-wide
mkdir -p ~/.archon
cp .env.example ~/.archon/.env

# Per-project override (e.g. a different Slack webhook for this repo)
mkdir -p /path/to/repo/.archon
printf 'SLACK_WEBHOOK=https://hooks.slack.com/...\n' > /path/to/repo/.archon/.env
```

## Docker Configuration

In Docker containers, paths are automatically set:

```
/.archon/
├── workspaces/owner/repo/
│   ├── source/
│   ├── worktrees/
│   ├── artifacts/
│   └── logs/
└── archon.db
```

Environment variables still work and override defaults.

## Command Folder Detection

When cloning or switching repositories, Archon looks for commands in this priority order:

1. `.archon/commands/` - Always searched first
2. Configured folder from `commands.folder` in `.archon/config.yaml` (if specified)

Example `.archon/config.yaml`:
```yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
  autoLoad: true
```

## Examples

### Minimal Setup (Using Defaults)

Archon uses these defaults without configuration:

- `~/.archon/` for all managed files
- The only registered provider as default AI assistant, otherwise no default
- Platform-appropriate streaming modes

With multiple providers, select a default with `archon setup`, `defaultAssistant` in global config, `assistant` in project config, or `DEFAULT_AI_ASSISTANT`. A run that needs an unset default fails before creating a worktree; workflows can select providers explicitly.

### Custom AI Preference

```yaml
# ~/.archon/config.yaml
defaultAssistant: codex
```

### Project-Specific Settings

```yaml
# .archon/config.yaml in your repo
assistant: claude  # Workflows inherit this provider unless they specify their own
commands:
  autoLoad: true
```

### Docker with Custom Volume

```bash
docker run -v /my/data:/.archon ghcr.io/coleam00/archon
```

## Streaming Modes

Telegram, Slack, and Discord adapters support two streaming modes. The server selects their runtime mode from environment variables. `~/.archon/config.yaml` accepts a `streaming` map keyed by platform identifier and exposes merged preferences through the config API; these YAML preferences currently do not control adapter construction. Existing `telegram`, `slack`, and `discord` keys remain accepted. Additional keys use lowercase kebab-case identifiers of at most 32 characters.

### Stream Mode

Messages are sent in real-time as the AI generates responses.

```ini
TELEGRAM_STREAMING_MODE=stream
SLACK_STREAMING_MODE=stream
DISCORD_STREAMING_MODE=stream
```

**Pros:**
- Real-time feedback and progress indication
- More interactive and engaging
- See AI reasoning as it works

**Cons:**
- More API calls to platform
- May hit rate limits with very long responses
- Creates many messages/comments

**Best for:** Interactive chat platforms (Telegram)

### Batch Mode

The assistant reply is sent after AI completes processing. Batch mode filters sections that start with tool-indicator emoji. If filtering leaves no text, it sends the original assistant messages joined with separators, including those indicators. Provider warnings are sent as they arrive.

Filtering operates on provider text blocks, including continuations split by an immediate warning. Adapters may split long replies into multiple platform messages or comments.

```ini
TELEGRAM_STREAMING_MODE=batch
SLACK_STREAMING_MODE=batch
DISCORD_STREAMING_MODE=batch
```

**Pros:**
- One assembled assistant reply before delivery; adapters may split long replies
- Fewer API calls
- No spam or clutter

**Cons:**
- Assistant text is held until processing completes
- Longer wait for first response
- Intermediate tool-indicator sections are normally omitted; the all-filtered fallback includes them

**Best for:** Issue trackers and async platforms (GitHub)

### Platform Defaults

| Platform | Default Mode |
|----------|-------------|
| Telegram | `stream` |
| Discord  | `batch` |
| Slack    | `batch` |
| GitHub   | `batch` |
| Web UI   | SSE streaming (always real-time, not configurable) |

---

## Workflow attention and continuation settings

`workflows:` can be set globally or per repository; repo fields override matching global fields.

| Field | Default | Meaning |
| --- | --- | --- |
| `toolCallAttentionMs` | `1800000` | Milliseconds without reported progress before an open provider tool call or reported background subtask raises advisory run attention. `0` disables publication; positive safe integers override the default |
| `autoResumeOnQuotaReset` | `true` | Wait until the reset instead of failing when a provider reports that its usage or credit limit is used up and when it resets, or when a rate limit outlasts its retries. `false` fails the run in both cases |
| `quotaFallbackDelayMs`, `quotaMaxAttempts`, `quotaDeadlineMs` | — | Deprecated and have no effect. They still parse, so an older config or a persisted run config stays readable, and loading one logs a deprecation warning |

Tool-call attention leaves the run and node running. It never kills, fails, cancels, pauses, retries, or resumes work. `workflow wait`, `workflow status`, and the console show the affected node, provider, tool, provider title or command, and duration. Providers that declare reported background work also receive advisories for subtasks with no open parent tool, using their task type and description. Subtasks retain their timing when their parent tool completes. A subtask's running update renews its progress; its terminal status clears its advisory. A tool's terminal update clears its advisory; a correlated subtask update renews only its parent tool and clears its advisory until the threshold passes again. Unrelated text or tool events do not count as that tool's progress. Leaving running state hides the advisory, and resume clears old descriptors.

The threshold follows the same global, repository, and run-scoped `workflows` layering. It is an operator policy, not a workflow YAML field. Even with publication disabled, typed open tools suspend the silence watchdog; streams with no open tools or reported live subtasks retain their existing idle timeout.

Attention stores only ids, timestamps, and bounded display fields. It never copies raw tool inputs, outputs, assistant messages, or reasoning from provider transcripts. Commands are redacted against known credentials from the effective environment and protected credential values, including file-delivered credentials. Arbitrary secrets unknown to Archon cannot be discovered by that redaction.

This policy is separate from per-node `retry:`. Quota exhaustion is terminal for the current attempt, because retrying in the same provider window only repeats the failure. When the attempt fails this way and the provider reported when the limit resets, the run does not fail. It pauses in a durable wait until that time, and a continuation host continues it once: `archon serve`, `archon workflow wake`, or the CLI process that started the run. The nodes that hit the limit run again. If they hit a limit again, the run waits again, until the new reset. `workflow status`, `workflow get`, the attention queue (item kind `usage_limit`) and the console show the wait with its node and reset time. Cancel or abandon the run to stop it.

The run waits only when every node that failed in that pass hit a usage limit with a reported reset, or a rate limit (below), and the latest of those deadlines is still ahead. This also applies to failed descendants inside loop groups and fan-outs. A node that failed downstream of another failed node, such as an `all_done` node reading a limited node's output, does not prevent the wait, whatever its own error was; it runs again when the run continues, and if it then fails after its upstream succeeded, that failure fails the run. A usage limit whose reset has already passed does not prevent waiting for another node's later deadline: when the run continues, both failed nodes retry. Any other failure, a usage limit without a reset time, or no deadline still ahead fails the run as before. Archon never guesses when a usage limit resets. A container run also fails, because the continuation host cannot continue one; resume it by hand.

A rate limit (`rate_limited`, such as HTTP 429) that still refuses a node after its retries takes the same wait. Its deadline is the provider's reset when the failure reports one that is still ahead; otherwise Archon waits a computed backoff of 5 to 15 minutes, jittered so runs limited together do not retry together. Resume the run to try sooner.

Only a provider's typed failure starts the wait; Archon never reads the error text for it. Claude reports a `quota_exhausted` failure, with the reset time, when its subscription window rejects a request or its credit balance runs out. Codex reports `quota_exhausted` when its usage limit is reached, with the reset time of the usage window that is full. Pi does not: its SDK passes Archon only the error text, with no limit signal or reset time, so a Pi run that hits a usage limit fails, and you resume it once the limit reopens. No other provider reports a structured quota signal.

A run that an older Archon version scheduled under the earlier `quotaMaxAttempts` settings is still `failed` with a scheduled resume, and still wakes at its scheduled time.

## Concurrency Settings

Control how many conversations the system processes simultaneously:

```ini
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**How it works:**
- Conversations are processed with a lock manager
- If the max concurrent limit is reached, new messages are queued
- Prevents resource exhaustion and API rate limits
- Each conversation maintains its own independent context

**Tuning guidance:**

| Resources | Recommended Setting |
|-----------|-------------------|
| Low resources | 3-5 |
| Standard | 10 (default) |
| High resources | 20-30 (monitor API limits) |

---

## Health Check Endpoints

The application exposes health check endpoints for monitoring:

**Basic Health Check:**
```bash
curl http://localhost:3090/health
```
Returns: `{"status":"ok"}`

**Database Connectivity:**
```bash
curl http://localhost:3090/health/db
```
Returns: `{"status":"ok","database":"connected"}`

**Concurrency Status:**
```bash
curl http://localhost:3090/health/concurrency
```
Returns: `{"status":"ok","active":0,"queuedTotal":0,"maxConcurrent":10}`

Per-conversation acquisition and queue times are on the authenticated `GET /api/dashboard/conversations`.

**Use cases:**
- Docker healthcheck configuration
- Load balancer health checks
- Monitoring and alerting systems (Prometheus, Datadog, etc.)
- CI/CD deployment verification

---

## Troubleshooting

### Config Parse Errors

If your config file has invalid YAML syntax, Archon stops with an error naming the file:

```
'/Users/you/.archon/config.yaml' is not valid YAML (YAML Parse error: Unexpected token).
```

Common YAML syntax issues:
- Incorrect indentation (use spaces, not tabs)
- Missing colons after keys
- Unquoted values with special characters

Archon does not fall back to default settings: startup, `archon doctor`, run starts and workflow listings fail with this error until the file is fixed.
