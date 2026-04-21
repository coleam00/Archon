---
title: 설정 레퍼런스
description: YAML config, 환경 변수, streaming mode를 포함한 HarneesLab의 계층형 설정 시스템 전체 레퍼런스입니다.
category: reference
area: config
audience: [user, operator]
status: current
sidebar:
  order: 6
---

HarneesLab은 합리적인 기본값, 선택적 YAML config file, 환경 변수 override를 갖춘 계층형 설정 시스템을 지원합니다. 빠른 소개는 [시작하기: 설정](/getting-started/)을 참고하세요.

## 디렉터리 구조

### 사용자 레벨(~/.archon/)

```
~/.archon/
├── workspaces/owner/repo/  # Project-centric layout
│   ├── source/             # Clone or symlink -> local path
│   ├── worktrees/          # Git worktrees for this project
│   ├── artifacts/          # Workflow artifacts
│   └── logs/               # Workflow execution logs
├── archon.db               # SQLite database (when DATABASE_URL not set)
└── config.yaml             # Global configuration (optional)
```

### Repository 레벨(.archon/)

```
.archon/
├── commands/       # Custom commands
│   └── plan.md
├── workflows/      # Workflow definitions (YAML files)
└── config.yaml     # Repo-specific configuration (optional)
```

## 설정 우선순위

설정은 다음 순서로 로드됩니다(뒤에 오는 항목이 앞 항목을 override).

1. **Defaults** - 내장 기본값
2. **Global Config** - `~/.archon/config.yaml`
3. **Repo Config** - repository의 `.archon/config.yaml`
4. **Environment Variables** - 항상 가장 높은 우선순위

## Global 설정

사용자 전체 preference를 위해 `~/.archon/config.yaml`을 만듭니다.

```yaml
# Default AI assistant
defaultAssistant: claude # must match a registered provider (e.g. claude, codex)

# Assistant defaults
assistants:
  claude:
    model: sonnet
    settingSources:   # Which CLAUDE.md files the SDK loads (default: ['project'])
      - project       # Project-level CLAUDE.md (always recommended)
      - user          # Also load ~/.claude/CLAUDE.md (global preferences)
    # Optional: absolute path to the Claude Code executable.
    # Required in compiled HarneesLab binaries when CLAUDE_BIN_PATH is not set.
    # Accepts the native binary (~/.local/bin/claude from the curl installer)
    # or the npm-installed cli.js. Source/dev mode auto-resolves.
    # claudeBinaryPath: /absolute/path/to/claude
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo
    # codexBinaryPath: /absolute/path/to/codex  # Optional: Codex CLI path

# Streaming preferences per platform
streaming:
  telegram: stream # 'stream' or 'batch'
  discord: batch
  slack: batch
  github: batch

# Custom paths (usually not needed)
paths:
  workspaces: ~/.archon/workspaces
  worktrees: ~/.archon/worktrees

# Concurrency limits
concurrency:
  maxConversations: 10

```

## Repository 설정

프로젝트별 설정을 위해 임의의 repository에 `.archon/config.yaml`을 만듭니다.

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
    model: gpt-5.3-codex
    webSearchMode: live

# Commands configuration
commands:
  folder: .archon/commands
  autoLoad: true

# Worktree settings
worktree:
  baseBranch: main  # Optional: auto-detected from git when not set
  copyFiles:  # Optional: Additional files to copy to worktrees
    - .env.example -> .env  # Rename during copy
    - .vscode               # Copy entire directory
  initSubmodules: true  # Optional: default true — auto-detects .gitmodules and runs
                        # `git submodule update --init --recursive`. Set false to opt out.

# Documentation directory
docs:
  path: docs  # Optional: default is docs/

# Defaults configuration
defaults:
  loadDefaultCommands: true   # Load app's bundled default commands at runtime
  loadDefaultWorkflows: true  # Load app's bundled default workflows at runtime

# Per-project environment variables for workflow execution (Claude SDK only)
# Injected into the Claude subprocess env. Use the Web UI Settings panel for secrets.
# env:
#   MY_API_KEY: value
#   CUSTOM_ENDPOINT: https://...

```

### Claude settingSources

Session 중 Claude Agent SDK가 어떤 `CLAUDE.md` file을 로드할지 제어합니다.

| Value | 설명 |
|-------|-------------|
| `project` | project의 `CLAUDE.md`를 로드(기본값, 항상 포함) |
| `user` | `~/.claude/CLAUDE.md`도 로드(user의 global preference) |

**기본값**: `['project']` -- project-level instruction만 로드합니다.

Global 또는 repo config에 설정합니다.
```yaml
assistants:
  claude:
    settingSources:
      - project
      - user
```

`~/.claude/CLAUDE.md`에 coding style이나 identity preference를 관리하고 HarneesLab session이 이를 따르길 원할 때 유용합니다.

**기본 동작:** `.archon/` directory는 항상 worktree에 자동 복사됩니다(artifact, plan, workflow 포함). `.env`나 `.vscode` 같은 추가 파일에만 `copyFiles`를 사용하세요.

**Defaults 동작:** 앱의 bundled default command와 workflow는 runtime에 로드되고 repo-specific 항목과 병합됩니다. Repo command/workflow가 같은 이름의 app default를 override합니다. runtime loading을 끄려면 `defaults.loadDefaultCommands: false` 또는 `defaults.loadDefaultWorkflows: false`를 설정하세요.

**Submodule 동작:** repo에 `.gitmodules`가 있으면 새 worktree에서 기본적으로 submodule을 초기화합니다(`git worktree add`는 이를 수행하지 않음). 이 검사는 저렴한 filesystem probe이므로 submodule이 없는 repo에는 비용이 없습니다. Submodule init 실패는 빈 submodule directory를 조용히 만드는 대신 credential, network, timeout 등으로 분류된 error를 throw합니다. 비활성화하려면 `worktree.initSubmodules: false`를 설정하세요.

**Base branch 동작:** worktree를 만들기 전에 canonical workspace를 최신 코드로 sync합니다. 해석 순서:
1. `worktree.baseBranch`가 설정된 경우: 설정된 branch를 사용합니다. 해당 branch가 remote에 없으면 **오류로 실패**합니다(silent fallback 없음).
2. 생략된 경우: `git remote show origin`으로 default branch를 auto-detect합니다. 표준 repo는 설정 없이 동작합니다.
3. auto-detection이 실패하고 workflow가 `$BASE_BRANCH`를 참조하는 경우: resolution chain을 설명하는 오류로 실패합니다.

**Docs path 동작:** `docs.path` setting은 `$DOCS_DIR` variable이 가리키는 위치를 제어합니다. 설정하지 않으면 `$DOCS_DIR`는 `docs/`가 기본값입니다. `$BASE_BRANCH`와 달리 이 변수는 항상 안전한 기본값을 가지며 오류를 throw하지 않습니다. 문서가 표준 `docs/` directory 밖에 있을 때(예: `packages/docs-web/src/content/docs`) 설정하세요.

## 환경 변수

환경 변수는 다른 모든 설정을 override합니다. 아래에는 category별로 정리되어 있습니다.

### Core

| Variable | 설명 | Default |
| --- | --- | --- |
| `ARCHON_HOME` | HarneesLab-managed file의 base directory | `~/.archon` |
| `PORT` | HTTP server listen port | `3090`(worktree에서는 auto-allocated) |
| `LOG_LEVEL` | Logging verbosity(`fatal`, `error`, `warn`, `info`, `debug`, `trace`) | `info` |
| `BOT_DISPLAY_NAME` | batch-mode "starting" message에 표시할 bot name | `HarneesLab` |
| `DEFAULT_AI_ASSISTANT` | 기본 AI assistant(registered provider와 일치해야 함) | `claude` |
| `MAX_CONCURRENT_CONVERSATIONS` | 최대 동시 AI conversation 수 | `10` |
| `SESSION_RETENTION_DAYS` | N일보다 오래된 inactive session 삭제 | `30` |
| `ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING` | `1`로 설정하면 Claude Code session 안에서 `archon` 실행 시 stderr warning 숨김 | -- |

### AI Providers -- Claude

| Variable | 설명 | Default |
| --- | --- | --- |
| `CLAUDE_USE_GLOBAL_AUTH` | `claude /login`의 global auth 사용(`true`/`false`) | Auto-detect |
| `CLAUDE_CODE_OAUTH_TOKEN` | 명시적 OAuth token(global auth 대안) | -- |
| `CLAUDE_API_KEY` | 명시적 API key(global auth 대안) | -- |
| `TITLE_GENERATION_MODEL` | conversation title 생성용 lightweight model | SDK default |
| `ARCHON_CLAUDE_FIRST_EVENT_TIMEOUT_MS` | Claude subprocess가 hung으로 간주되기 전 timeout(ms, diagnostic log와 함께 throw) | `60000` |

`CLAUDE_USE_GLOBAL_AUTH`가 설정되지 않으면 HarneesLab은 자동 감지합니다. 명시적 token이 있으면 이를 사용하고, 없으면 global auth로 fallback합니다.

### AI Providers -- Codex

| Variable | 설명 | Default |
| --- | --- | --- |
| `CODEX_ID_TOKEN` | Codex ID token(`~/.codex/auth.json`에서 가져옴) | -- |
| `CODEX_ACCESS_TOKEN` | Codex access token | -- |
| `CODEX_REFRESH_TOKEN` | Codex refresh token | -- |
| `CODEX_ACCOUNT_ID` | Codex account ID | -- |

### Platform Adapters -- Slack

| Variable | 설명 | Default |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | Slack bot token(`xoxb-...`) | -- |
| `SLACK_APP_TOKEN` | Socket Mode용 Slack app-level token(`xapp-...`) | -- |
| `SLACK_ALLOWED_USER_IDS` | whitelist용 쉼표 구분 Slack user ID | Open access |
| `SLACK_STREAMING_MODE` | Streaming mode(`stream` 또는 `batch`) | `batch` |

### Platform Adapters -- Telegram

| Variable | 설명 | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | @BotFather에서 받은 Telegram bot token | -- |
| `TELEGRAM_ALLOWED_USER_IDS` | whitelist용 쉼표 구분 Telegram user ID | Open access |
| `TELEGRAM_STREAMING_MODE` | Streaming mode(`stream` 또는 `batch`) | `stream` |

### Platform Adapters -- Discord

| Variable | 설명 | Default |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Developer Portal에서 받은 Discord bot token | -- |
| `DISCORD_ALLOWED_USER_IDS` | whitelist용 쉼표 구분 Discord user ID | Open access |
| `DISCORD_STREAMING_MODE` | Streaming mode(`stream` 또는 `batch`) | `batch` |

### Platform Adapters -- GitHub

| Variable | 설명 | Default |
| --- | --- | --- |
| `GITHUB_TOKEN` | GitHub personal access token(`gh` CLI도 사용) | -- |
| `GH_TOKEN` | `GITHUB_TOKEN` alias(GitHub CLI가 사용) | -- |
| `WEBHOOK_SECRET` | GitHub webhook signature verification용 HMAC SHA-256 secret | -- |
| `GITHUB_ALLOWED_USERS` | whitelist용 쉼표 구분 GitHub username(대소문자 무시) | Open access |
| `GITHUB_BOT_MENTION` | issue/PR에서 bot이 응답할 @mention name | `BOT_DISPLAY_NAME`으로 fallback |

### Platform Adapters -- Gitea

| Variable | 설명 | Default |
| --- | --- | --- |
| `GITEA_URL` | Self-hosted Gitea instance URL(예: `https://gitea.example.com`) | -- |
| `GITEA_TOKEN` | Gitea personal access token 또는 bot account token | -- |
| `GITEA_WEBHOOK_SECRET` | Gitea webhook signature verification용 HMAC SHA-256 secret | -- |
| `GITEA_ALLOWED_USERS` | whitelist용 쉼표 구분 Gitea username(대소문자 무시) | Open access |
| `GITEA_BOT_MENTION` | issue/PR에서 bot이 응답할 @mention name | `BOT_DISPLAY_NAME`으로 fallback |

### Database

| Variable | 설명 | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string(SQLite 사용 시 생략) | `~/.archon/archon.db`의 SQLite |

### Web UI

| Variable | 설명 | Default |
| --- | --- | --- |
| `WEB_UI_ORIGIN` | API route용 CORS origin(공개 노출 시 제한) | `*`(모두 허용) |
| `WEB_UI_DEV` | 설정되면 static frontend serving을 건너뜀(대신 Vite dev server 사용) | -- |

### Worktree 관리

| Variable | 설명 | Default |
| --- | --- | --- |
| `STALE_THRESHOLD_DAYS` | inactive worktree를 stale로 간주하기 전 일수 | `14` |
| `MAX_WORKTREES_PER_CODEBASE` | auto-cleanup 전 codebase당 최대 worktree 수 | `25` |
| `CLEANUP_INTERVAL_HOURS` | background cleanup service 실행 주기 | `6` |

### Docker / Deployment

| Variable | 설명 | Default |
| --- | --- | --- |
| `ARCHON_DATA` | HarneesLab data(workspaces, worktrees, artifacts)의 host path | Docker-managed volume |
| `DOMAIN` | Caddy reverse proxy용 public domain(TLS auto-provisioned) | -- |
| `CADDY_BASIC_AUTH` | Web UI와 API 보호용 Caddy basicauth directive | Disabled |
| `AUTH_USERNAME` | form-based auth(Caddy forward_auth) username | -- |
| `AUTH_PASSWORD_HASH` | form-based auth password의 bcrypt hash(Compose에서는 `$`를 `$$`로 escape) | -- |
| `COOKIE_SECRET` | auth session cookie용 64-hex-char secret | -- |
| `AUTH_SERVICE_PORT` | auth service container port | `9000` |
| `COOKIE_MAX_AGE` | auth cookie lifetime(seconds) | `86400` |

### `.env` 파일 위치

Infrastructure configuration(database URL, platform token)은 `.env` file에 저장합니다.

| Component | 위치 | 목적 |
|-----------|----------|---------|
| **CLI** | `~/.archon/.env` | Global infrastructure config; CWD .env key를 먼저 strip한 뒤 `override: true`로 로드(HarneesLab config가 shell-inherited var보다 우선) |
| **Server (dev)** | `<archon-repo>/.env` + `~/.archon/.env` | Repo `.env`는 platform token용; `~/.archon/.env`는 `override: true`로 로드 |
| **Server (binary)** | `~/.archon/.env` | 단일 source of truth(compiled binary에서는 repo `.env` path 사용 불가) |

**동작 방식**: 시작 시 CLI와 server는 현재 작업 디렉터리의 `.env`, `.env.local`, `.env.development`, `.env.production`에서 Bun이 자동 로드한 모든 key와 nested Claude Code session marker(auth var를 제외한 `CLAUDECODE`, `CLAUDE_CODE_*`)를 제거한 뒤 `~/.archon/.env`를 로드합니다. 이렇게 하면 target repo key와 nested-session guard가 어떤 application code도 실행되기 전에 `process.env`에서 완전히 제거됩니다.

**Best practice**: `~/.archon/.env`를 단일 source of truth로 사용하세요.

```bash
# Create global config
mkdir -p ~/.archon
cp .env.example ~/.archon/.env
# Edit with your values
```

## Docker 설정

Docker container에서는 path가 자동으로 설정됩니다.

```
/.archon/
├── workspaces/owner/repo/
│   ├── source/
│   ├── worktrees/
│   ├── artifacts/
│   └── logs/
└── archon.db
```

환경 변수는 그대로 동작하며 기본값을 override합니다.

## Command folder 감지

Repository를 clone하거나 전환할 때 HarneesLab은 다음 우선순위로 command를 찾습니다.

1. `.archon/commands/` - 항상 먼저 검색
2. `.archon/config.yaml`의 `commands.folder`에서 설정한 folder(지정된 경우)

`.archon/config.yaml` 예시:
```yaml
commands:
  folder: .claude/commands/archon  # Additional folder to search
  autoLoad: true
```

## 예시

### 최소 설정(기본값 사용)

설정이 필요 없습니다. HarneesLab은 기본적으로 다음으로 동작합니다.

- 모든 managed file은 `~/.archon/` 사용
- 기본 AI assistant는 Claude
- 플랫폼에 맞는 streaming mode

### Custom AI preference

```yaml
# ~/.archon/config.yaml
defaultAssistant: codex
```

### Project-specific setting

```yaml
# .archon/config.yaml in your repo
assistant: claude  # Workflows inherit this provider unless they specify their own
commands:
  autoLoad: true
```

### Custom volume을 사용하는 Docker

```bash
docker run -v /my/data:/.archon ghcr.io/newturn2017/harneeslab
```

## Streaming mode

각 platform adapter는 환경 변수 또는 `~/.archon/config.yaml`로 설정하는 두 가지 streaming mode를 지원합니다.

### Stream mode

AI가 응답을 생성하는 동안 message를 실시간으로 보냅니다.

```ini
TELEGRAM_STREAMING_MODE=stream
SLACK_STREAMING_MODE=stream
DISCORD_STREAMING_MODE=stream
```

**장점:**
- 실시간 feedback과 progress indication
- 더 상호작용적이고 몰입감 있음
- AI reasoning이 진행되는 모습을 볼 수 있음

**단점:**
- platform API call 증가
- 매우 긴 응답에서 rate limit에 걸릴 수 있음
- 많은 message/comment 생성

**적합한 곳:** Interactive chat platform(Telegram)

### Batch mode

AI 처리가 끝난 뒤 최종 summary message만 보냅니다.

```ini
TELEGRAM_STREAMING_MODE=batch
SLACK_STREAMING_MODE=batch
DISCORD_STREAMING_MODE=batch
```

**장점:**
- 하나의 일관된 message/comment
- API call 감소
- spam이나 clutter 없음

**단점:**
- 처리 중 progress indication 없음
- 첫 응답까지 더 오래 기다림
- intermediate step을 볼 수 없음

**적합한 곳:** Issue tracker와 async platform(GitHub)

### Platform 기본값

| Platform | Default Mode |
|----------|-------------|
| Telegram | `stream` |
| Discord  | `batch` |
| Slack    | `batch` |
| GitHub   | `batch` |
| Web UI   | SSE streaming(항상 real-time, 설정 불가) |

---

## 동시성 설정

시스템이 동시에 처리하는 conversation 수를 제어합니다.

```ini
MAX_CONCURRENT_CONVERSATIONS=10  # Default: 10
```

**동작 방식:**
- Conversation은 lock manager로 처리됩니다.
- 최대 동시 실행 한도에 도달하면 새 message는 queue에 들어갑니다.
- Resource exhaustion과 API rate limit을 방지합니다.
- 각 conversation은 독립된 context를 유지합니다.

**튜닝 가이드:**

| Resources | 권장 설정 |
|-----------|-------------------|
| Low resources | 3-5 |
| Standard | 10(default) |
| High resources | 20-30(API limit monitoring 필요) |

---

## Health check endpoint

애플리케이션은 monitoring을 위한 health check endpoint를 제공합니다.

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
Returns: `{"status":"ok","active":0,"queued":0,"maxConcurrent":10}`

**사용 사례:**
- Docker healthcheck configuration
- Load balancer health check
- Monitoring and alerting system(Prometheus, Datadog 등)
- CI/CD deployment verification

---

## 문제 해결

### Config parse error

Config file에 잘못된 YAML syntax가 있으면 다음과 같은 error message가 표시됩니다.

```
[Config] Failed to parse global config at ~/.archon/config.yaml: <error details>
[Config] Using default configuration. Please fix the YAML syntax in your config file.
```

자주 발생하는 YAML syntax issue:
- 잘못된 indentation(tab 대신 space 사용)
- key 뒤 colon 누락
- special character가 있는 unquoted value

Config file을 고칠 때까지 애플리케이션은 default setting으로 계속 실행됩니다.
