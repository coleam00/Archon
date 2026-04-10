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

```
~/.archon/                    # ARCHON_HOME
├── workspaces/               # Cloned repositories (project-centric layout)
│   └── owner/
│       └── repo/
│           ├── source/       # Clone or symlink -> local path
│           └── worktrees/    # Git worktrees for this project
├── worktrees/                # Legacy global worktrees (for repos not in workspaces/)
├── web-dist/<version>/       # Cached web UI dist (archon serve, binary only)
├── update-check.json         # Update check cache (binary builds only, 24h TTL)
└── config.yaml               # Global user configuration
```

**Purpose:**
- `workspaces/` - Repositories cloned via `/clone` command or GitHub adapter
- `workspaces/owner/repo/worktrees/` - Git worktrees for this project (new registrations)
- `worktrees/` - Legacy fallback for repos not registered under `workspaces/`
- `config.yaml` - Non-secret user preferences

### Repo-Level: `.archon/`

```
any-repo/.archon/
├── commands/                 # Custom commands
│   ├── plan.md
│   └── execute.md
├── workflows/                # Workflow definitions (YAML files)
│   └── pr-review.yaml
└── config.yaml               # Repo-specific configuration
```

**Purpose:**
- `commands/` - Slash commands (auto-loaded on clone)
- `workflows/` - YAML workflow definitions, discovered recursively at runtime
- `config.yaml` - Project-specific settings

### Docker: `/.archon/`

In Docker containers, the Archon home is fixed at `/.archon/` (root level). This is:
- Mounted as a named volume for persistence
- Not overridable by end users (simplifies container setup)

## Path Resolution

All path resolution is centralized in `packages/paths/src/archon-paths.ts` (`@archon/paths`).

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
| Default AI Assistant | `DEFAULT_AI_ASSISTANT` | `claude` |
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

1. Add function to `packages/paths/src/archon-paths.ts`:
```typescript
export function getArchonNewPath(): string {
  return join(getArchonHome(), 'new-directory');
}
```

2. Update Docker setup in `Dockerfile`
3. Update volume mounts in `docker-compose.yml`
4. Add tests in `packages/paths/src/archon-paths.test.ts`

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
