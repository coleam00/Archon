---
title: 빠른 참조
description: 모든 CLI command, variable, YAML option을 한 페이지에서 빠르게 확인합니다.
category: book
part: advanced
audience: [user]
sidebar:
  order: 10
---

이 장은 모든 CLI command, variable, YAML option을 한곳에 모읍니다. 긴 설명 없이 필요한 사실만 제공합니다. 무엇이 필요한지 알고 있고 syntax만 빠르게 확인하고 싶을 때 사용하세요.

---

## CLI command

### `archon workflow`

| Command | 설명 |
|---------|-------------|
| `archon workflow list` | 사용 가능한 모든 workflow 나열 |
| `archon workflow list --json` | machine-readable JSON output |
| `archon workflow run <name> "<prompt>"` | workflow 실행 |
| `archon workflow run <name> --branch <name> "<prompt>"` | 명시적 브랜치로 실행 |
| `archon workflow run <name> --no-worktree "<prompt>"` | live checkout에서 실행(isolation 없음) |
| `archon workflow run <name> --cwd /path "<prompt>"` | 특정 디렉터리를 대상으로 실행 |
| `archon workflow status` | 활성 workflow run 상태 표시 |
| `archon workflow resume <run-id>` | 실패한 workflow run 재개 |
| `archon workflow abandon <run-id>` | terminal 상태가 아닌 workflow run 포기 |
| `archon workflow cleanup [days]` | 오래된 workflow run record 삭제(기본: 7일) |

### `archon isolation`

| Command | 설명 |
|---------|-------------|
| `archon isolation list` | 모든 활성 worktree 나열 |
| `archon isolation cleanup` | 오래된 worktree 제거(7일 초과) |
| `archon isolation cleanup <days>` | N일보다 오래된 worktree 제거 |
| `archon isolation cleanup --merged` | main에 merge된 branch의 worktree 제거 |
| `archon isolation cleanup --merged --include-closed` | 닫힌(abandoned) PR의 worktree도 제거 |

### `archon complete`

| Command | 설명 |
|---------|-------------|
| `archon complete <branch>` | worktree, local branch, remote branch 제거 |
| `archon complete <branch> --force` | uncommitted-change check 건너뛰기 |

### `archon validate`

| Command | 설명 |
|---------|-------------|
| `archon validate workflows` | 모든 workflow definition 검증 |
| `archon validate workflows <name>` | 단일 workflow 검증 |
| `archon validate workflows <name> --json` | machine-readable validation output |
| `archon validate commands` | 모든 command file 검증 |
| `archon validate commands <name>` | 단일 command 검증 |

### `archon version`

```bash
archon version
```

---

## 변수

variable은 command body와 workflow `prompt:` field에서 runtime에 치환됩니다.

| Variable | 사용 위치 | 포함하는 값 |
|----------|-------------|----------|
| `$ARGUMENTS` | Commands, prompts | command에 전달된 모든 argument를 하나의 string으로 |
| `$1`, `$2`, `$3` | Commands, prompts | 첫 번째, 두 번째, 세 번째 positional argument |
| `$ARTIFACTS_DIR` | Commands, prompts | workflow run의 artifact directory 절대 경로 |
| `$WORKFLOW_ID` | Commands, prompts | 현재 workflow run ID |
| `$BASE_BRANCH` | Commands, prompts | base git branch(자동 감지 또는 `worktree.baseBranch`로 설정) |
| `$DOCS_DIR` | Commands, prompts | 문서 디렉터리 경로(기본: `docs/`) |
| `$<nodeId>.output` | DAG `when:` condition, downstream `prompt:` field | 완료된 node의 text output |

**예시:**

```bash
# Pass a module name to a command
archon workflow run my-workflow "auth"
# $ARGUMENTS = "auth", $1 = "auth"

# Multi-argument
archon workflow run my-workflow "auth refresh-tokens"
# $ARGUMENTS = "auth refresh-tokens", $1 = "auth", $2 = "refresh-tokens"
```

```yaml
# Reference a node's output in a condition
- id: implement
  command: implement-changes
  when: "$classify.output.type == 'BUG'"
```

---

## Workflow YAML schema

### Top-level option

| Field | 필수 | Type | 설명 |
|-------|----------|------|-------------|
| `name` | 예 | string | `archon workflow list`에서 workflow 식별 |
| `description` | 예 | string | 목록에 표시되고 router가 사용 |
| `nodes` | 예 | array | DAG node(아래 Node Options 참조) |
| `provider` | 아니요 | string | 등록된 provider identifier(예: `claude`, `codex`). 기본: `claude` |
| `model` | 아니요 | string | 모든 node의 model(`sonnet`, `opus`, `haiku` 또는 full model ID) |
| `modelReasoningEffort` | 아니요 | string | Codex only: `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `webSearchMode` | 아니요 | string | Codex only: `disabled` \| `cached` \| `live` |
| `additionalDirectories` | 아니요 | string[] | AI가 접근할 수 있는 추가 디렉터리 |

### Node option (DAG)

모든 node는 다음 base field를 공유합니다.

| Field | 필수 | Type | 설명 |
|-------|----------|------|-------------|
| `id` | 예 | string | 고유 node identifier. `depends_on`과 `$nodeId.output`에서 사용 |
| `command` | 다음 중 하나 | string | `.archon/commands/`에 있는 command file 이름 |
| `prompt` | 다음 중 하나 | string | inline AI instructions |
| `bash` | 다음 중 하나 | string | shell script(AI 없이 실행, stdout은 `$nodeId.output`으로 capture) |
| `loop` | 다음 중 하나 | object | loop configuration(아래 Loop Options 참조) |
| `depends_on` | 아니요 | string[] | 이 node가 실행되기 전 완료되어야 하는 node ID |
| `when` | 아니요 | string | condition expression. false면 node skip |
| `trigger_rule` | 아니요 | string | multiple upstream이 있을 때 join semantics(Trigger Rules 참조) |
| `provider` | 아니요 | string | node별 provider override(등록된 provider) |
| `model` | 아니요 | string | node별 model override |
| `context` | 아니요 | `fresh` \| `shared` | session context. `fresh`는 새 conversation, `shared`는 이전 node에서 상속 |
| `output_format` | 아니요 | JSON Schema | 이 node의 structured JSON output 강제 |
| `allowed_tools` | 아니요 | string[] | 사용 가능한 tool을 이 목록으로 제한(Claude only) |
| `denied_tools` | 아니요 | string[] | 이 node context에서 특정 tool 제거(Claude only) |
| `idle_timeout` | 아니요 | number | node별 idle timeout, millisecond 단위(기본: 5분) |
| `retry` | 아니요 | object | transient failure retry configuration(Retry Options 참조) |
| `hooks` | 아니요 | object | SDK hook callback(Claude only, Hook Schema 참조) |
| `mcp` | 아니요 | string | MCP server config JSON file 경로(Claude only) |
| `skills` | 아니요 | string[] | 이 node context에 미리 로드할 skill 이름(Claude only) |

> **bash node timeout**: bash node의 `timeout` field는 **milliseconds** 단위입니다(기본: 120000). 초 단위인 hook `timeout`과 다릅니다.

### Trigger rule

| 값 | 동작 |
|-------|----------|
| `all_success` | 모든 upstream node가 성공한 경우에만 실행(기본값) |
| `one_success` | upstream node 중 하나 이상 성공하면 실행 |
| `none_failed_min_one_success` | 실패한 upstream이 없고 하나 이상 성공하면 실행 |
| `all_done` | 결과와 관계없이 모든 upstream node가 완료된 뒤 실행 |

### Loop node option

node 내부의 `loop:` 아래에 정의합니다.

| Field | 필수 | Type | 설명 |
|-------|----------|------|-------------|
| `prompt` | 예 | string | 각 iteration에서 실행되는 AI instructions |
| `until` | 예 | string | completion signal string. AI output에 포함되면 loop 종료 |
| `max_iterations` | 예 | number | node 실패 전 최대 iteration 수 |
| `fresh_context` | 아니요 | boolean | 각 iteration마다 새 session 시작(기본: false) |
| `until_bash` | 아니요 | string | 각 iteration 후 실행되는 shell script. exit 0이면 완료 signal |

**예시:**

```yaml
- id: refine
  loop:
    prompt: "Review the current draft and improve it. Output COMPLETE when done."
    until: "COMPLETE"
    max_iterations: 5
```

### Retry option

node 내부의 `retry:` 아래에 정의합니다.

| Field | 필수 | 기본값 | 설명 |
|-------|----------|---------|-------------|
| `max_attempts` | 예 | — | 최초 실패 후 retry 횟수(최대: 5) |
| `delay_ms` | 아니요 | 3000 | 초기 delay, millisecond 단위. attempt마다 두 배(1000-60000) |
| `on_error` | 아니요 | `transient` | `transient`는 rate limit/network error retry. `all`은 fatal error를 제외한 모든 것 retry |

> **Fatal error는 절대 retry하지 않습니다**: auth failure, permission error, credit balance exhausted는 retry config와 관계없이 즉시 실패합니다.

---

## Hook schema

hook은 `hooks:` 아래에 node별로 정의합니다. 전체 예시는 [9장](/book/hooks-and-quality/)을 보세요.

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"    # Regex against tool name. Omit to match all.
      timeout: 60              # Seconds. Default: 60.
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          additionalContext: "Verify the file before writing"
          permissionDecision: deny    # allow | deny | ask
          permissionDecisionReason: "Not allowed in this node"
          updatedInput:               # Override tool arguments
            file_path: "/sandbox/out.ts"
  PostToolUse:
    - matcher: "Read"
      response:
        hookSpecificOutput:
          hookEventName: PostToolUse
          additionalContext: "This file is read-only. Do not modify it."
```

| Hook Event | 실행 시점 |
|------------|--------------|
| `PreToolUse` | tool 실행 전 |
| `PostToolUse` | tool이 성공적으로 완료된 뒤 |
| `PostToolUseFailure` | tool 실패 후 |
| `SessionStart` / `SessionEnd` | session lifecycle event 발생 시 |
| `Stop` | agent가 멈출 때 |

---

## 디렉터리 구조

### `~/.archon/` (user-level)

```
~/.archon/
├── config.yaml                        # Global configuration (non-secrets)
├── archon.db                          # SQLite database (default; no DATABASE_URL needed)
└── workspaces/
    └── <owner>/
        └── <repo>/
            ├── source/                # Git clone or symlink to local path
            ├── worktrees/             # Per-task git worktrees
            ├── artifacts/             # Workflow artifacts (never committed)
            └── logs/                  # Workflow execution logs (JSONL)
```

### `.archon/` (repo-level)

```
.archon/
├── config.yaml                        # Repo-specific configuration
├── commands/                          # Custom command files (*.md)
│   └── my-command.md
└── workflows/                         # Custom workflow files (*.yaml)
    └── my-workflow.yaml
```

**Bundled defaults** — 내장 command와 workflow는 Archon에 포함되어 자동으로 로드됩니다. 같은 이름의 repo-level file은 bundled version을 override합니다. 기본값을 완전히 비활성화하려면:

```yaml
# .archon/config.yaml
defaults:
  loadDefaultCommands: false
  loadDefaultWorkflows: false
```

---

## 문제 해결

### 흔한 error

| Error | 가능성 높은 원인 | 해결 |
|-------|-------------|-----|
| `Workflow "X" not found` | YAML file이 발견되지 않음 | 파일이 `.archon/workflows/`에 있고 `archon workflow list`에 표시되는지 확인 |
| `Command "X" not found` | Command file 없음 | `.archon/commands/X.md`가 있고 `archon validate commands X`가 통과하는지 확인 |
| `Routing unclear — falling back to archon-assist` | input과 match되는 workflow 없음 | 명시적 workflow 이름 사용: `archon workflow run my-workflow "..."` |
| `Worktree already exists for branch X` | 이전 run이 worktree를 남김 | `archon complete X` 또는 `archon isolation cleanup` 실행 |
| `Not a git repository` | repo 밖에서 실행 중 | 먼저 git repo로 `cd`. workflow와 isolation command에는 git repo가 필요 |
| `Model X is not valid for provider Y` | provider/model mismatch | 각 provider가 받는 model이 다릅니다. provider의 `isModelCompatible` rule을 확인하세요. Claude는 `sonnet`, `opus`, `haiku`, `claude-*`를 받고 Codex는 다른 model을 받습니다. |
| `$BASE_BRANCH referenced but could not be detected` | base branch가 설정되지 않았고 auto-detection 실패 | `.archon/config.yaml`에 `worktree.baseBranch`를 설정하거나 `main`/`master`가 있는지 확인 |
| Workflow hangs with no output | node idle timeout 도달 | node의 `idle_timeout`을 늘림(milliseconds) |

### Debug technique

**Archon이 찾은 항목 보기:**
```bash
archon workflow list          # Are your workflows loaded?
archon validate workflows     # Any YAML errors?
archon isolation list         # Any stale worktrees?
```

**verbose logging 활성화:**
```bash
archon --verbose workflow run my-workflow "..."
```

**execution log 확인** — 각 run은 JSONL log를 씁니다.
```
~/.archon/workspaces/<owner>/<repo>/logs/
```

**debugging 단순화를 위해 isolation 없이 실행:**
```bash
archon workflow run my-workflow --no-worktree "..."
```

**workflow에 넣기 전에 command 직접 테스트:**
```bash
archon workflow run archon-assist "/command-invoke my-command some-arg"
```

### 도움 받기

- **YAML 검증**: `archon validate workflows my-workflow`
- **log 확인**: `~/.archon/workspaces/<owner>/<repo>/logs/`
- **issue 보고**: [github.com/anthropics/claude-code/issues](https://github.com/anthropics/claude-code/issues)

---

전체 가이드를 모두 다뤘습니다. mental model부터 hook, 이 reference까지 살펴봤습니다. 무언가를 빠르게 찾아봐야 할 때 이 페이지로 돌아오면 됩니다.
