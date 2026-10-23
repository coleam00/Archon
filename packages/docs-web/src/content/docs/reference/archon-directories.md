---
title: Archon Directories
description: Directory structure, path resolution, and configuration system for Archon.
category: reference
area: config
audience: [developer]
status: current
sidebar:
  order: 2
---

This document explains the Archon directory structure and configuration system for developers contributing to or extending Archon.

## Overview

Archon provides a unified directory and configuration system with:

1. **Consistent paths** across all platforms (Mac, Linux, Windows, Docker)
2. **Configuration precedence** chain (env > global > repo > defaults)
3. **Workflow engine integration** with YAML definitions in `.archon/workflows/`

## Directory Structure

### User-Level: `~/.archon/`

The workspace entries below show default shapes. Registration allocates a unique,
readable name when a new project would share another project's name or storage root.
For example, a repository can use `acme/api-2` or `_local/api-2`, and a folder can
use `_folder/my-app-2`. New managed projects with nested namespaces receive a
safe two-part name: `org/team/subteam/project` starts at `org/team-subteam-project`,
with a suffix if needed. That allocated identity scopes their checkout, storage,
and worktrees together. Local repositories with bare names retain the `_local/<basename>`
layout below. Existing projects keep their names and storage.

```
~/.archon/                          # ARCHON_HOME
├── workspaces/                     # Per-project storage (project-centric layout)
│   ├── <owner>/<repo>/             #   a registered repo with a remote
│   ├── _local/<basename>/          #   a no-remote local git repo
│   ├── _folder/<slug>/             #   a folder project (runs in place; git is user/agent-owned)
│   └── @cwd/<basename>-<digest>/   #   an unregistered working directory
│       ├── source/                 # Clone or symlink -> local path (repo kinds only)
│       ├── worktrees/              # Git worktrees for this project (repo kinds only)
│       ├── artifacts/              # Workflow artifacts — NEVER in git
│       │   ├── runs/<run-id>/      #   $ARTIFACTS_DIR for one run
│       │   │   ├── .archon/        #     engine-owned bookkeeping, never listed as artifacts
│       │   │   │   ├── node-output-spills/  # oversized shell handoffs (*.nodeoutput)
│       │   │   │   ├── scratch/             # throwaway checkouts and installs; removed when the run ends
│       │   │   │   └── typed-artifacts/     # typed-artifact observation files
│       │   │   └── nodes/          #     typed output sidecars (<id>.md + <id>.meta.json)
│       │   ├── scopes/<workflow>/<scope>/   # cross-invocation artifacts (persist_session)
│       │   └── uploads/<conv-id>/  #   Web UI file uploads (ephemeral)
│       ├── logs/<run-id>.jsonl     # Workflow execution logs
│       ├── state/                  # $STATE_DIR — cross-run state, shared per project
│       └── workflow-source/runs/<run-id>/  # The frozen workflow source one run executes
├── workflows/  commands/  scripts/ # Home-scoped ("global") definitions
├── temp/                           # Ephemeral scratch (per-simulation dry-run dirs; removed when the run ends)
├── worktrees/                      # Legacy global worktrees (repos not in workspaces/)
├── vendor/codex/                   # Codex native binary (binary builds, user-placed)
├── plugins/                        # Installed plugins: executables, installed/**/receipt.json, packs/
├── server/<version>/               # Cached server executable (archon serve, binary only)
├── web-dist/<version>/             # Cached web UI dist (archon serve, binary only)
├── update-check.json               # Update check cache (binary builds only, 1h release-data TTL; 24h CLI notice interval)
├── tier-notice.json                # One-time tier-default notice state (CLI, per version)
├── install.json                    # Last compiled CLI path and version (discovery hint)
├── credential-key                  # Auto-provisioned per-user credential encryption key
├── store-id                        # Opaque id of this home, returned by GET /api/health
├── server.json                     # The server listening for this home (discovery record)
├── archon.db                       # SQLite database (when DATABASE_URL is unset)
└── config.yaml                     # Global user configuration
```

**Purpose:**
- `workspaces/<project>/` - Everything one project produces. The project segment is
  resolved once per run from the allocated codebase identity. Default shapes are: `owner/repo` for a repo with a
  remote, `_local/<basename>` for a no-remote local repo, `_folder/<slug>` for a folder
  project, and `@cwd/<basename>-<digest>` when a run has no registered codebase at all. Folder
  projects and `@cwd` projects have no `source/` or `worktrees/` — they run in place.
  The `@cwd` digest is SHA-256 of the resolved absolute directory path.
  The `@cwd` namespace cannot be a registered repository owner and is separate from legacy
  `_cwd/<basename>` output, which remains untouched; see [cross-run state](/reference/variables/)
  for handling legacy state.
- `workspaces/<project>/artifacts/` - Run output. `$ARTIFACTS_DIR` is
  `artifacts/runs/<run-id>/`. Oversized values passed to shell nodes are retained in the
  engine-owned `.archon/` child so concurrent runs never share the deferred read and
  workflow-authored root files remain untouched. That child is the engine's own bookkeeping:
  `archon workflow get` and the console run page list a run's artifacts without it. Archon
  retains filesystem run artifacts until the operator removes them, with one exception:
  `.archon/scratch/`, where a workflow puts throwaway checkouts and dependency installs, is
  removed once the run is completed, failed or cancelled (including a failed run that is
  resumed later) and its nodes have stopped. A container run's scratch is removed when its
  container is. A run whose nodes Archon cannot confirm stopped (its owner ran on another
  host, or its owner process is still alive) keeps its scratch until the operator removes it.
  A CLI run stopped by a signal (Ctrl-C, SIGTERM) is marked failed without stopping its nodes
  through Archon, so it keeps its scratch until it is abandoned or its conversation is reset.
  Everything else in `$ARTIFACTS_DIR` is kept.
  `archon workflow cleanup` deletes old database run records, not these directories.
- `workspaces/<project>/logs/` - One JSONL execution log per run.
- `workspaces/<project>/state/` - `$STATE_DIR`. Cross-run workflow state, shared by every
  workflow in the project. Survives worktree teardown; never visible to git.
- `worktrees/` - Legacy fallback for repos not registered under `workspaces/`
- `plugins/` - Everything `archon plugin add` and `archon provider add` write.
  Plugin executables such as `archon-provider-codex` (`.exe` on Windows) sit at the top,
  each plugin's receipt is `installed/<owner>/<repo>[/<path>]/receipt.json`, and
  workflow pack trees live under `packs/`. Release binaries load the Claude, Codex
  and Pi providers only from these receipts; source checkouts and Docker run them
  from source and ignore receipts for those three.
- `install.json` - Discovery metadata for the last compiled Archon invoked. GUI and
  service consumers may use its absolute `binary` path when the user has not
  configured one explicitly. Source/Bun runs do not write this file.
- `store-id` - A random id generated the first time a server starts on this home and kept
  for the home's life. `GET /api/health` returns it as `storeId`, so a client can compare it
  with this file to confirm the server it reached serves this home and not another one.
- `server.json` - Written by a server once it is listening and removed when it shuts down
  cleanly: `pid`, `port`, `host` (the bound address), `version`, `startedAt` and `storeId`.
  A same-machine client reads it to find the server instead of guessing a port. The record is
  advisory: treat a missing or unreadable file, or one whose `pid` is no longer running (the
  server was killed), as no server. When several servers share one home, the file names the
  most recent to start.
- `config.yaml` - Non-secret user preferences

Each run also records the project root it resolved in `workflow_runs.output_root`, so an
old run's artifacts stay addressable even if the codebase is later renamed.

### Repo-Level: `.archon/`

```
any-repo/.archon/
├── commands/                 # Custom commands
│   ├── plan.md
│   └── execute.md
├── workflows/                # Workflow definitions (YAML files)
│   └── pr-review.yaml
├── scripts/                  # Named scripts for script: nodes (.ts/.js for bun, .py for uv)
└── config.yaml               # Repo-specific configuration
```

**Purpose:**
- `commands/` - Slash commands (auto-loaded on clone)
- `workflows/` - YAML workflow definitions in flat, one-level grouped, or exact `<pack>/<workflow>/` packaged layouts
- `scripts/` - Named scripts referenced by `script:` nodes
- `config.yaml` - Project-specific settings

The repo directory holds **source** only. Everything a run produces lives under
`~/.archon/workspaces/<project>/`.

#### Legacy: `.archon/state/`

`.archon/state/` was a prompt-level convention with no engine support — workflows did
`mkdir -p .archon/state` relative to cwd. It had two problems: inside an isolated run that
path is the *worktree*, so the "cross-run memory" was destroyed at cleanup; and Archon
never writes a `.gitignore`, so in a user's repository the directory was fully stageable.

It is replaced by [`$STATE_DIR`](/reference/variables/). Archon no longer checks this
legacy directory or warns about it, and does not read or move its contents. To migrate
state, set `STATE_DIR` in your shell to the destination used by your workflow, then run
from the repository:

```bash
mkdir -p "$STATE_DIR"
mv .archon/state/* "$STATE_DIR"/
```

The glob moves non-hidden entries. Inspect hidden entries and destination conflicts
before moving them.

Then replace `.archon/state/` with `$STATE_DIR/` in the workflow's prompts and scripts, and
delete any `mkdir -p .archon/state` — the executor pre-creates `$STATE_DIR`.

### Docker: `/.archon/`

In Docker containers, the Archon home is fixed at `/.archon/` (root level). This is:
- Mounted as a named volume for persistence
- Not overridable by end users (simplifies container setup)

## Path Resolution

All path resolution is centralized in `@archon/paths`, one module per area in `packages/paths/src/`: `home-paths.ts` for `ARCHON_HOME` and what lives directly under it, `project-paths.ts` for project identity and storage, and `run-paths.ts` for a run's artifacts and logs.

### Core Functions

```typescript
// Get the Archon home directory
getArchonHome(): string
// Returns: ~/.archon (local) or /.archon (Docker)

// Get workspaces directory
getArchonWorkspacesPath(): string
// Returns: ${ARCHON_HOME}/workspaces

// Get global worktrees directory (legacy fallback)
getArchonWorktreesPath(): string
// Returns: ${ARCHON_HOME}/worktrees

// Get global config path
getArchonConfigPath(): string
// Returns: ${ARCHON_HOME}/config.yaml

// Get the compiled CLI discovery manifest path
getInstallManifestPath(): string
// Returns: ${ARCHON_HOME}/install.json

// Get cached web UI distribution directory for a given version
getWebDistDir(version: string): string
// Returns: ${ARCHON_HOME}/web-dist/${version}

// Get command folder search paths (priority order)
getCommandFolderSearchPaths(configuredFolder?: string): string[]
// Returns: ['.archon/commands'] + configuredFolder if specified
```

### Docker Detection

```typescript
function isDocker(): boolean {
  return (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true'
  );
}
```

### WSL Detection

```typescript
function isWSL(): boolean {
  // Either signal is sufficient:
  //   - WSL_DISTRO_NAME env var is set (always true inside a WSL distro)
  //   - /proc/sys/kernel/osrelease contains "microsoft" (lower-cased)
  // The /proc read is wrapped in try/catch: on environments without a
  // readable /proc (macOS, Windows, restricted sandboxes) it conservatively
  // returns false.
}

function getWSLDistroName(): string | undefined {
  // Returns the WSL_DISTRO_NAME env var if present, otherwise undefined.
  // Only reads the env var — isWSL() may still be true via the /proc
  // fallback while this returns undefined.
}
```

Used to build Windows-host-friendly `vscode://vscode-remote/wsl+<distro>/...` IDE URIs when Archon runs inside WSL (surfaced as `is_wsl` / `wsl_distro` on `/api/health`).

### Platform-Specific Paths

| Platform | `getArchonHome()` |
|----------|-------------------|
| macOS | `/Users/<username>/.archon` |
| Linux | `/home/<username>/.archon` |
| Windows | `C:\Users\<username>\.archon` |
| Docker | `/.archon` |

## Configuration System

### Precedence Chain

Configuration is resolved in this order (highest to lowest priority):

1. **Environment Variables** - Secrets, deployment-specific
2. **Global Config** (`~/.archon/config.yaml`) - User preferences
3. **Repo Config** (`.archon/config.yaml`) - Project-specific
4. **Built-in Defaults** - Hardcoded in `packages/core/src/config/config-types.ts`

### Config Loading

```typescript
// Load merged config for a repo
const config = await loadConfig(repoPath);

// Load just global config
const globalConfig = await loadGlobalConfig();

// Load just repo config
const repoConfig = await loadRepoConfig(repoPath);
```

### Configuration Options

Key configuration options:

| Option | Env Override | Default |
|--------|--------------|---------|
| `ARCHON_HOME` | `ARCHON_HOME` | `~/.archon` |
| Default AI Assistant | `DEFAULT_AI_ASSISTANT` | Only registered provider, otherwise unset |
| Telegram Streaming | `TELEGRAM_STREAMING_MODE` | `stream` |
| Discord Streaming | `DISCORD_STREAMING_MODE` | `batch` |
| Slack Streaming | `SLACK_STREAMING_MODE` | `batch` |

## Command Folders

Command detection searches in priority order:

1. `.archon/commands/` - Always searched first
2. Configured folder from `commands.folder` in `.archon/config.yaml` (if specified)

Example configuration:
```yaml
# .archon/config.yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
```

## Extension Points

### Adding New Paths

To add a new managed directory:

1. Add the function to its area module, here `packages/paths/src/home-paths.ts`, and export it from `packages/paths/src/index.ts`:
```typescript
export function getArchonNewPath(): string {
  return join(getArchonHome(), 'new-directory');
}
```

2. Update Docker setup in `Dockerfile`
3. Update volume mounts in `docker-compose.yml`
4. Add tests beside it in `packages/paths/src/home-paths.test.ts`

### Adding Config Options

To add new configuration options:

1. Add type to `packages/core/src/config/config-types.ts`:
```typescript
export interface GlobalConfig {
  // ...existing
  newFeature?: {
    enabled?: boolean;
    setting?: string;
  };
}
```

2. Add default in `getDefaults()` function
3. Use via `loadConfig()` in your code

## Design Decisions

### Why `~/.archon/` instead of `~/.config/archon/`?

- Simpler path (fewer nested directories)
- Follows Claude Code pattern (`~/.claude/`)
- Cross-platform without XDG complexity
- Easy to find and manage manually

### Why YAML for config?

- Bun has native support (via `yaml` package)
- Supports comments (unlike JSON)
- Workflow definitions use YAML
- Human-readable and editable

### Why fixed Docker paths?

- Simplifies container setup
- Predictable volume mounts
- No user confusion about env vars in containers
- Matches convention (apps use fixed paths in containers)

### Why config precedence chain?

- Mirrors git config pattern (familiar to developers)
- Secrets stay in env vars (security)
- User preferences in global config (portable)
- Project settings in repo config (version-controlled)

## UI Integration

The config type system is designed for:
- Web UI configuration
- API-driven config updates
- Real-time config validation
