---
title: CLI 레퍼런스
description: HarneesLab command-line interface와 사용 가능한 모든 명령에 대한 전체 레퍼런스입니다.
category: reference
area: cli
audience: [user]
status: current
sidebar:
  order: 3
---

터미널에서 AI 기반 workflow를 실행합니다.

## 사전 준비

1. Repository를 clone하고 dependency를 설치합니다.
   ```bash
   git clone https://github.com/NewTurn2017/HarneesLab
   cd HarneesLab
   bun install
   ```

2. CLI를 전역에서 사용할 수 있게 만듭니다(권장).
   ```bash
   cd packages/cli
   bun link
   ```
   이렇게 하면 어디서든 `hlab` command를 사용할 수 있습니다.

3. Claude에 인증합니다.
   ```bash
   claude /login
   ```

**참고:** 아래 예시는 `bun link` 이후의 `hlab`을 사용합니다. 2단계를 건너뛰었다면 repo directory에서 `bun run cli`를 사용하세요.

## 빠른 시작

```bash
# 사용 가능한 workflow 목록(git repository 필요)
hlab workflow list --cwd /path/to/repo

# workflow 실행(기본적으로 격리 worktree 자동 생성)
hlab workflow run assist --cwd /path/to/repo "Explain the authentication flow"

# worktree branch 이름 직접 지정
hlab workflow run plan --cwd /path/to/repo --branch feature-auth "Add OAuth support"

# isolation 비활성화(live checkout에서 실행)
hlab workflow run assist --cwd /path/to/repo --no-worktree "간단한 질문"
```

**참고:** Workflow와 isolation command는 git repository 안에서 실행해야 합니다. Subdirectory에서 실행하면 repo root를 자동으로 찾습니다. `version`, `help`, `chat`, `setup`, `serve` command는 어디서든 동작합니다.

## 명령

### `chat <message>`

일회성 AI interaction을 위해 orchestrator에 message를 보냅니다.

```bash
hlab chat "What does the orchestrator do?"
```

### `setup`

Credential과 configuration을 위한 interactive setup wizard입니다.

```bash
hlab setup
hlab setup --spawn  # 새 terminal window에서 열기
```

**옵션**

| Flag | 효과 |
| --- | --- |
| `--spawn` | 새 terminal window에서 setup wizard 열기 |

### `workflow list`

Target directory에서 사용할 수 있는 workflow를 나열합니다.

```bash
hlab workflow list --cwd /path/to/repo

# script에서 쓰기 좋은 machine-readable output
hlab workflow list --cwd /path/to/repo --json
```

`.archon/workflows/`(recursive), `~/.archon/.archon/workflows/`(global), bundled default에서 workflow를 찾습니다. [Global Workflows](/guides/global-workflows/)를 참고하세요.

**옵션**

| Flag | 효과 |
| --- | --- |
| `--cwd <path>` | Target directory(대부분의 사용 사례에서 필요) |
| `--json` | formatted text 대신 machine-readable JSON 출력 |

`--json`을 사용하면 `{ "workflows": [...], "errors": [...] }`를 출력합니다. Workflow에 설정되지 않은 optional field(`provider`, `model`, `modelReasoningEffort`, `webSearchMode`)는 생략됩니다.

### `workflow run <name> [message]`

선택적 user message와 함께 workflow를 실행합니다.

```bash
# 기본 사용
hlab workflow run assist --cwd /path/to/repo "What does this function do?"

# isolation 사용
hlab workflow run plan --cwd /path/to/repo --branch feature-x "Add caching"
```

실행 중 progress event(node start/complete/fail/skip, approval gate)는 stderr에 기록됩니다.

**옵션**

| Flag | 효과 |
| --- | --- |
| `--cwd <path>` | Target directory(대부분의 사용 사례에서 필요) |
| `--branch <name>` | worktree에 사용할 명시적 branch name |
| `--from <branch>`, `--from-branch <branch>` | base branch override(worktree start-point) |
| `--no-worktree` | isolation을 사용하지 않고 live checkout에서 직접 실행 |
| `--resume` | working path의 마지막 failed run부터 resume(완료된 node는 skip) |
| `--quiet`, `-q` | stderr progress output 모두 숨김 |
| `--verbose`, `-v` | tool-level event(tool name과 duration)도 표시 |

**기본값(no flags):**
- auto-generated branch(`archon/task-<workflow>-<timestamp>`)로 worktree 생성
- git repo 안이면 codebase auto-register

**`--branch` 사용 시:**
- `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/`에 worktree 생성/재사용
- 정상 상태의 기존 worktree가 있으면 재사용

**`--no-worktree` 사용 시:**
- target directory에서 직접 실행(isolation 없음)
- `--branch`, `--from`과 함께 사용할 수 없음

**Name matching:**

Workflow name은 4단계 fallback hierarchy로 해석됩니다. CLI와 모든 chat platform(Slack, Telegram, Web, GitHub, Discord)에 동일하게 적용됩니다.
1. **Exact match** - `archon-assist`가 `archon-assist`와 일치
2. **Case-insensitive** - `ARCHON-ASSIST`가 `archon-assist`와 일치
3. **Suffix match** - `assist`가 `archon-assist`와 일치(`-assist` suffix 검색)
4. **Substring match** - `smart`가 `archon-smart-pr-review`와 일치

같은 단계에서 여러 workflow가 match되면 후보를 나열하는 오류가 발생합니다.
```
Ambiguous workflow 'review'. Did you mean:
  - archon-review
  - custom-review
```

### `workflow status`

모든 worktree의 running workflow run을 표시합니다.

```bash
hlab workflow status
hlab workflow status --json
```

### `workflow resume`

실패한 workflow run을 resume합니다. Workflow를 다시 실행하며 이전 run에서 완료된 node는 자동으로 skip합니다.

```bash
hlab workflow resume <run-id>
```

### `workflow abandon`

Workflow run을 폐기합니다(`cancelled`로 표시). Resume하지 않을 worktree를 unblock할 때 사용합니다. Path lock이 즉시 해제되어 새 workflow를 시작할 수 있습니다.

```bash
hlab workflow abandon <run-id>
```

### `workflow approve`

Interactive approval gate에서 paused workflow run을 승인합니다. 선택적으로 `$LOOP_USER_INPUT`을 통해 workflow가 사용할 comment를 제공할 수 있습니다.

```bash
hlab workflow approve <run-id>
hlab workflow approve <run-id> "Looks good, proceed"
hlab workflow approve <run-id> --comment "Looks good, proceed"
```

### `workflow reject`

Approval gate에서 paused workflow run을 거절합니다. 선택적으로 `$REJECTION_REASON`을 통해 workflow가 사용할 reason을 제공할 수 있습니다.

```bash
hlab workflow reject <run-id>
hlab workflow reject <run-id> --reason "Needs more tests"
```

### `workflow cleanup`

Database에서 오래된 terminal workflow run record를 삭제합니다.

```bash
hlab workflow cleanup        # 기본값: 7일
hlab workflow cleanup 30     # custom threshold
```

### `workflow event emit`

Workflow event를 database에 직접 emit합니다. 주로 workflow loop prompt 내부에서 story-level lifecycle event를 기록할 때 사용합니다.

```bash
hlab workflow event emit --run-id <uuid> --type <event-type> [--data <json>]
```

**옵션**

| Flag | 필수 | 설명 |
| --- | --- | --- |
| `--run-id` | 예 | workflow run의 UUID |
| `--type` | 예 | Event type(예: `ralph_story_started`, `node_completed`) |
| `--data` | 아니요 | event에 첨부할 JSON string. 잘못된 JSON은 warning을 출력하고 무시됩니다. |

Exit code: 성공 시 0, `--run-id` 또는 `--type`이 없거나 `--type`이 유효하지 않은 event type이면 1입니다. Event persistence는 best-effort(non-throwing)입니다. Event가 보이지 않으면 server log를 확인하세요.

### `isolation list`

모든 active worktree environment를 표시합니다.

```bash
hlab isolation list
```

Codebase별로 grouping해 branch, workflow type, platform, last activity 이후 경과일을 보여줍니다.

### `isolation cleanup [days]`

Stale environment를 제거합니다.

```bash
# 기본값: 7일
hlab isolation cleanup

# custom threshold
hlab isolation cleanup 14

# main에 merge된 branch의 environment 제거(remote branch도 삭제)
hlab isolation cleanup --merged

# merge 없이 closed된 PR의 environment도 제거
hlab isolation cleanup --merged --include-closed
```

Merge detection은 세 가지 signal을 순서대로 사용합니다: git branch ancestry(fast-forward / merge commit), patch equivalence(`git cherry`를 통한 squash-merge), GitHub PR state(`gh` CLI). `gh` CLI는 optional입니다. 없으면 git signal만 사용합니다.

기본적으로 **CLOSED** PR이 있는 branch는 skip합니다. 이 branch도 정리하려면 `--include-closed`를 전달하세요. **OPEN** PR이 있는 branch는 항상 skip됩니다.

### `validate workflows [name]`

Workflow YAML definition과 참조 resource(command file, MCP config, skill directory)를 검증합니다.

```bash
hlab validate workflows                      # 모든 workflow 검증
hlab validate workflows my-workflow          # 단일 workflow 검증
hlab validate workflows my-workflow --json   # machine-readable JSON output
```

검사 항목: YAML syntax, DAG structure(cycle, dependency ref), command file 존재 여부, MCP config file, skill directory, provider compatibility. Typo에는 "did you mean?" suggestion이 포함된 actionable error message를 반환합니다.

Exit code: 0 = 모두 valid, 1 = error 발견.

### `validate commands [name]`

`.archon/commands/`의 command file(.md)을 검증합니다.

```bash
hlab validate commands                  # 모든 command 검증
hlab validate commands my-command       # 단일 command 검증
```

검사 항목: file 존재, non-empty, valid name.

Exit code: 0 = 모두 valid, 1 = error 발견.

### `complete <branch> [branch2 ...]`

Branch의 worktree, local branch, remote branch를 제거하고 isolation environment를 destroyed로 표시합니다.

```bash
hlab complete feature-auth
hlab complete feature-auth --force  # uncommitted-changes check 건너뛰기
```

**옵션**

| Flag | 효과 |
| --- | --- |
| `--force` | uncommitted-changes guard 건너뛰기 |

PR이 merge되어 더 이상 worktree나 branch가 필요 없을 때 사용합니다. 여러 branch name을 한 번에 받을 수 있습니다.

### `serve`

Web UI server를 시작합니다. 첫 실행 시 matching GitHub release에서 pre-built web UI tarball을 download하고, SHA-256 checksum을 검증한 뒤 extract합니다. 이후 실행에서는 cache된 copy를 사용합니다.

**Binary install 전용**입니다. 개발 중에는 대신 `bun run dev`를 사용하세요.

```bash
# Web UI server 시작(첫 실행 시 download)
hlab serve

# 기본 port override
hlab serve --port 4000

# server를 시작하지 않고 Web UI만 download
hlab serve --download-only
```

**옵션**

| Flag | 효과 |
| --- | --- |
| `--port <port>` | server port override(default: 3090, range: 1-65535) |
| `--download-only` | web UI를 download/cache한 뒤 server 시작 없이 종료 |

Cached web UI는 `~/.archon/web-dist/<version>/`에 저장됩니다. Version별로 독립적으로 cache되므로 binary upgrade 시 matching web UI가 자동으로 download됩니다.

### `version`

Version, build type, database info를 표시합니다.

```bash
hlab version
```

## 전역 옵션

| Option | 효과 |
| --- | --- |
| `--cwd <path>` | working directory override(default: current directory) |
| `--quiet`, `-q` | log verbosity를 warning/error로 줄임 |
| `--verbose`, `-v` | debug-level output 표시 |
| `--json` | machine-readable JSON 출력(workflow list, workflow status) |
| `--help`, `-h` | help message 표시 |

## 작업 디렉터리

CLI는 다음 기준으로 실행 위치를 결정합니다.

1. `--cwd` flag(제공된 경우)
2. 현재 directory(default)

Subdirectory(예: `/repo/packages/cli`)에서 실행하면 git repository root(예: `/repo`)로 자동 해석됩니다.

`--branch`를 사용하면 workflow는 worktree directory 안에서 실행됩니다.

> **Command와 workflow는 runtime에 working directory에서 로드됩니다.** CLI는 disk에서 직접 읽으므로 uncommitted change도 즉시 반영합니다. 이는 server(Telegram/Slack/GitHub)와 다릅니다. Server는 `~/.archon/workspaces/`의 workspace clone에서 읽으며, 이 clone은 worktree creation 전 remote에서만 sync하므로 변경사항을 적용하려면 push가 필요합니다.

## 환경

시작 시 CLI는 Bun이 자동 로드한 CWD `.env` key와 nested Claude Code session marker를 `process.env`에서 제거한 뒤 global `.env`를 로드합니다. global `.env` 위치는 `HARNEESLAB_HOME`, `ARCHON_HOME`, `~/.archon` 순서로 결정됩니다. 해당 `.env`에 설정한 모든 key는 AI subprocess로 전달됩니다. allowlist filtering은 없습니다.

시작 시 CLI는 다음을 수행합니다.
1. CWD `.env` key + `CLAUDECODE` marker를 `process.env`에서 제거(`stripCwdEnv`)
2. `$HARNEESLAB_HOME/.env`, `$ARCHON_HOME/.env`, `~/.archon/.env` 순서로 global `.env` 로드(모든 key trusted)
3. 명시적 token이 없으면 global Claude auth 자동 활성화

## 데이터베이스

- **`DATABASE_URL` 없음(기본값):** `~/.archon/archon.db`의 SQLite 사용 -- 설정 불필요, 첫 실행 시 자동 초기화
- **`DATABASE_URL` 있음:** PostgreSQL 사용(선택 사항, cloud/advanced deployment용)

둘 다 투명하게 동작합니다. 대부분의 사용자는 database를 설정할 필요가 없습니다.

## 예시

```bash
# 일회성 AI chat
hlab chat "How does error handling work in this codebase?"

# interactive setup wizard
hlab setup

# 빠른 질문(archon/task-assist-<timestamp> 형태의 branch로 자동 isolation)
hlab workflow run assist --cwd ~/projects/my-app "How does error handling work here?"

# isolation 없이 빠른 질문
hlab workflow run assist --cwd ~/projects/my-app --no-worktree "How does error handling work here?"

# feature 계획(auto-isolated)
hlab workflow run plan --cwd ~/projects/my-app "Add rate limiting to the API"

# 명시적 branch 이름으로 구현
hlab workflow run implement --cwd ~/projects/my-app --branch feature-rate-limit "Add rate limiting"

# auto-detected default 대신 특정 source branch에서 시작
hlab workflow run implement --cwd ~/projects/my-app --branch test-adapters --from feature/extract-adapters "Test adapter changes"

# paused workflow 승인 또는 거절
hlab workflow approve <run-id> "Ship it"
hlab workflow reject <run-id> --reason "Missing test coverage"

# 작업 후 worktree 확인
hlab isolation list

# 오래된 worktree 정리
hlab isolation cleanup
```
