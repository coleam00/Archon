---
title: Archon 디렉터리
description: Archon의 디렉터리 구조, 경로 해석, 설정 시스템을 설명합니다.
category: reference
area: config
audience: [developer]
status: current
sidebar:
  order: 2
---

이 문서는 Archon에 기여하거나 Archon을 확장하는 개발자를 위해 Archon의 디렉터리 구조와 설정 시스템을 설명합니다. HarneesLab은 Archon fork이므로 repo-local `.archon/` workflow convention은 유지하되, user-level runtime env는 `HARNEESLAB_HOME`을 우선 지원합니다.

## 개요

Archon은 다음을 갖춘 통합 디렉터리 및 설정 시스템을 제공합니다.

1. 모든 플랫폼(Mac, Linux, Windows, Docker)에서 **일관된 경로**
2. **설정 우선순위** 체인(env > global > repo > defaults)
3. `.archon/workflows/`의 YAML definition과 연동되는 **workflow engine integration**

## 디렉터리 구조

### 사용자 레벨: `~/.archon/` 또는 `HARNEESLAB_HOME`

기본값은 `~/.archon/`이며, `HARNEESLAB_HOME`이 설정된 경우 그 값이 root가 됩니다.

```
~/.archon/                    # or $HARNEESLAB_HOME
├── workspaces/               # Cloned repositories (project-centric layout)
│   └── owner/
│       └── repo/
│           ├── source/       # Clone or symlink -> local path
│           └── worktrees/    # Git worktrees for this project
├── worktrees/                # Legacy global worktrees (for repos not in workspaces/)
├── web-dist/<version>/       # Cached web UI dist (hlab serve, binary only)
├── update-check.json         # Update check cache (binary builds only, 24h TTL)
└── config.yaml               # Global user configuration
```

**목적:**
- `workspaces/` - `/clone` command 또는 GitHub adapter로 clone한 repository
- `workspaces/owner/repo/worktrees/` - 이 project의 git worktree(새 registration)
- `worktrees/` - `workspaces/` 아래에 등록되지 않은 repo를 위한 legacy fallback
- `config.yaml` - secret이 아닌 user preference

### Repo 레벨: `.archon/`

```
any-repo/.archon/
├── commands/                 # Custom commands
│   ├── plan.md
│   └── execute.md
├── workflows/                # Workflow definitions (YAML files)
│   └── pr-review.yaml
└── config.yaml               # Repo-specific configuration
```

**목적:**
- `commands/` - slash command(clone 시 auto-load)
- `workflows/` - YAML workflow definition, runtime에 recursive discovery
- `config.yaml` - project-specific setting

### Docker: `/.harneeslab/` 또는 `/.archon/`

새 Docker compose 구성에서는 HarneesLab home이 root level의 `/.harneeslab/`입니다. 기존 `ARCHON_DOCKER`/`/.archon` 구성은 compatibility path로 계속 지원됩니다. 이 경로는 다음 특성을 가집니다.
- 지속성을 위해 named volume으로 mount
- `HARNEESLAB_HOME` 또는 legacy `ARCHON_HOME`으로 container 내부 home을 명시적으로 override 가능

## 경로 해석

모든 path resolution은 `packages/paths/src/archon-paths.ts`(`@harneeslab/paths`)에 중앙화되어 있습니다.

### 핵심 함수

```typescript
// Get the Archon home directory
getArchonHome(): string
// Returns: HARNEESLAB_HOME, ARCHON_HOME, ~/.archon (local), or Docker home

// Get workspaces directory
getArchonWorkspacesPath(): string
// Returns: ${HarneesLab home}/workspaces

// Get global worktrees directory (legacy fallback)
getArchonWorktreesPath(): string
// Returns: ${HarneesLab home}/worktrees

// Get global config path
getArchonConfigPath(): string
// Returns: ${HarneesLab home}/config.yaml

// Get cached web UI distribution directory for a given version
getWebDistDir(version: string): string
// Returns: ${HarneesLab home}/web-dist/${version}

// Get command folder search paths (priority order)
getCommandFolderSearchPaths(configuredFolder?: string): string[]
// Returns: ['.archon/commands'] + configuredFolder if specified
```

### Docker 감지

```typescript
function isDocker(): boolean {
  return (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.HARNEESLAB_DOCKER === 'true' ||
    process.env.ARCHON_DOCKER === 'true'
  );
}
```

### 플랫폼별 경로

| Platform | `getArchonHome()` |
|----------|-------------------|
| macOS | `/Users/<username>/.archon` |
| Linux | `/home/<username>/.archon` |
| Windows | `C:\Users\<username>\.archon` |
| Docker(new compose) | `/.harneeslab` |
| Docker(legacy compose) | `/.archon` |

## 설정 시스템

### 우선순위 체인

설정은 다음 순서로 해석됩니다(위가 가장 높은 우선순위).

1. **Environment Variables** - Secret, deployment-specific 설정
2. **Global Config** (`~/.archon/config.yaml`) - User preference
3. **Repo Config** (`.archon/config.yaml`) - Project-specific 설정
4. **Built-in Defaults** - `packages/core/src/config/config-types.ts`에 hardcode된 기본값

### 설정 로딩

```typescript
// Load merged config for a repo
const config = await loadConfig(repoPath);

// Load just global config
const globalConfig = await loadGlobalConfig();

// Load just repo config
const repoConfig = await loadRepoConfig(repoPath);
```

### 설정 옵션

주요 설정 옵션:

| Option | Env Override | Default |
|--------|--------------|---------|
| HarneesLab home | `HARNEESLAB_HOME` (`ARCHON_HOME` fallback) | `~/.archon` |
| Default AI Assistant | `DEFAULT_AI_ASSISTANT` | `claude` |
| Telegram Streaming | `TELEGRAM_STREAMING_MODE` | `stream` |
| Discord Streaming | `DISCORD_STREAMING_MODE` | `batch` |
| Slack Streaming | `SLACK_STREAMING_MODE` | `batch` |

## Command folder

Command detection은 다음 우선순위로 검색합니다.

1. `.archon/commands/` - 항상 먼저 검색
2. `.archon/config.yaml`의 `commands.folder`에서 설정한 folder(지정된 경우)

설정 예시:
```yaml
# .archon/config.yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
```

## 확장 지점

### 새 경로 추가

새 managed directory를 추가하려면:

1. `packages/paths/src/archon-paths.ts`에 function 추가:
```typescript
export function getArchonNewPath(): string {
  return join(getArchonHome(), 'new-directory');
}
```

2. `Dockerfile`의 Docker setup 업데이트
3. `docker-compose.yml`의 volume mount 업데이트
4. `packages/paths/src/archon-paths.test.ts`에 test 추가

### 설정 옵션 추가

새 configuration option을 추가하려면:

1. `packages/core/src/config/config-types.ts`에 type 추가:
```typescript
export interface GlobalConfig {
  // ...existing
  newFeature?: {
    enabled?: boolean;
    setting?: string;
  };
}
```

2. `getDefaults()` function에 default 추가
3. 코드에서 `loadConfig()`를 통해 사용

## 설계 결정

### 왜 `~/.config/archon/` 대신 `~/.archon/`인가?

- 더 단순한 path(중첩 directory가 적음)
- Claude Code pattern(`~/.claude/`)을 따름
- XDG 복잡성 없이 cross-platform 지원
- 사람이 직접 찾고 관리하기 쉬움

### 왜 config에 YAML을 사용하는가?

- Bun이 native 지원(`yaml` package 사용)
- JSON과 달리 comment 지원
- Workflow definition이 YAML을 사용
- 사람이 읽고 편집하기 좋음

### 왜 Docker path를 고정하는가?

- Container setup 단순화
- 예측 가능한 volume mount
- Container 환경 변수와 path에 대한 사용자 혼란 감소
- Convention과 일치(container app은 fixed path를 사용하는 경우가 많음)

### 왜 config precedence chain을 사용하는가?

- git config pattern과 유사해 개발자에게 익숙함
- Secret은 env var에 유지(보안)
- User preference는 global config에 유지(portable)
- Project setting은 repo config에 유지(version-controlled)

## UI 통합

Config type system은 다음을 위해 설계되었습니다.
- Web UI configuration
- API-driven config update
- Real-time config validation
