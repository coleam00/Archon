---
title: 워크플로 작성
description: DAG 노드, 조건부 분기, 병렬 실행을 사용하는 다단계 YAML workflow를 만듭니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 1
---

이 가이드는 여러 command를 자동화 pipeline으로 orchestrate하는 workflow를 만드는 방법을 설명합니다. workflow는 command로 구성되므로 먼저 [명령 작성](/guides/authoring-commands/)을 읽어보세요.

## Workflow란 무엇인가요?

workflow는 실행할 command의 directed acyclic graph(DAG)를 정의하는 **YAML file**입니다. workflow는 다음을 가능하게 합니다.

- **Multi-step automation**: 여러 AI agents를 연결합니다
- **Parallel execution**: 독립적인 node를 동시에 실행합니다
- **Conditional branching**: node output에 따라 다른 path로 route합니다
- **Artifact passing**: 한 node의 output이 downstream node의 input이 됩니다
- **Iterative loops**: loop node가 completion signal까지 반복됩니다

```yaml
name: fix-github-issue
description: Investigate and fix a GitHub issue end-to-end

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

> **default를 template으로 사용하기:** HarneesLab은 `.archon/workflows/defaults/`에 default workflows를 제공합니다. `.archon`과 `archon-*` workflow 이름은 upstream Archon과의 호환성을 위해 유지됩니다. 실제 예시를 살펴본 뒤 복사해서 수정하세요.
> ```bash
> cp .archon/workflows/defaults/archon-fix-github-issue.yaml .archon/workflows/my-fix-issue.yaml
> ```
> `.archon/workflows/`의 같은 이름 file은 bundled default를 덮어씁니다.

---

## 파일 위치

workflow는 working directory 기준 `.archon/workflows/`에 둡니다. `.archon` 디렉터리 이름은 repo-local workflow convention으로 계속 유지됩니다.

```
.archon/
├── workflows/
│   ├── my-workflow.yaml
│   └── review/
│       └── full-review.yaml    # Subdirectories work
└── commands/
    └── [commands used by workflows]
```

HarneesLab은 workflow를 recursive하게 발견하므로 subdirectory를 사용할 수 있습니다. workflow file load에 실패하면(syntax error, validation failure) 해당 file은 skip되고 error가 `hlab workflow list` 또는 `/workflow list`에 보고됩니다.

> **Global workflows:** 모든 project에 적용되는 workflow는 `~/.archon/.archon/workflows/`에 두세요. global workflow는 같은 이름의 repo workflow에 의해 덮어써집니다. [전역 워크플로](/guides/global-workflows/)를 참고하세요.

> **CLI vs Server:** CLI는 실행한 위치에서 workflow file을 읽습니다(uncommitted changes도 보임). server는 `~/.archon/workspaces/owner/repo/`의 workspace clone에서 읽으며, 이 clone은 worktree creation 전에 remote에서만 sync됩니다. workflow를 local에서 수정하고 push하지 않으면 server는 변경을 보지 못합니다.

---

## Workflow 구조

workflow는 `nodes:`를 사용하는 DAG-based execution을 사용합니다. 각 node는 command 또는 inline prompt를 실행하고, dependency를 선언하며, conditional branching을 지원합니다.

```yaml
name: classify-and-fix
description: Classify issue type, then run the appropriate fix path

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success
```

`depends_on`이 없는 node는 즉시 실행됩니다. 같은 topological layer의 node는 `Promise.allSettled`를 통해 동시에 실행됩니다. skipped node(`when:` condition 또는 `trigger_rule` 실패)는 skipped state를 dependant로 전파합니다.

> **참고:** `steps:`(sequential) format은 제거되었습니다. 모든 workflow는 `nodes:`(DAG) format만 사용합니다.

---

## DAG 기반 Workflow Schema

```yaml
# Required
name: workflow-name
description: |
  What this workflow does.

# Optional workflow-level configuration
provider: claude
model: sonnet
modelReasoningEffort: medium     # Codex only
webSearchMode: live              # Codex only
interactive: true                # Web only: run in foreground instead of background

# Required for DAG-based
nodes:
  - id: classify                 # Unique node ID (used for dependency refs and $id.output)
    command: classify-issue      # Loads from .archon/commands/classify-issue.md
    output_format:               # Optional: enforce structured JSON output (Claude + Codex)
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]       # Wait for classify to complete
    when: "$classify.output.type == 'BUG'"  # Skip if condition is false

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success  # Run if at least one dep succeeded

  - id: inline-node
    prompt: "Summarize the changes made in $implement.output"  # Inline prompt (no command file)
    depends_on: [implement]
    context: fresh               # Force fresh session for this node
    provider: claude             # Per-node provider override
    model: haiku                 # Per-node model override
    # hooks:                     # Optional: per-node SDK hook callbacks (Claude only) — see hooks guide
    # mcp: .archon/mcp/servers.json  # Optional: per-node MCP servers (Claude only)
    # skills: [remotion-best-practices]  # Optional: per-node skills (Claude only) — see skills guide
```

### Node Fields

**Node types** — node마다 정확히 하나가 필요합니다(mutually exclusive).

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | `.archon/commands/`에서 로드할 command name |
| `prompt` | string | inline prompt string |
| `bash` | string | shell script(AI 없음). stdout은 `$nodeId.output`으로 capture됩니다. optional `timeout`(ms, 기본값 120000) |
| `loop` | object | completion signal까지 반복되는 AI prompt입니다. [Loop 노드](/guides/loop-nodes/) 참고 |
| `approval` | object | human review를 위해 workflow를 일시 중지합니다. [Approval 노드](/guides/approval-nodes/) 참고 |
| `cancel` | string | reason string과 함께 workflow run을 종료합니다. 기존 cancellation plumbing을 사용하며 in-flight parallel node는 중지됩니다 |

**Common fields** — 모든 node type에 적용됩니다.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | unique node identifier. `depends_on`, `when:`, `$id.output` substitution에 사용됩니다 |
| `depends_on` | string[] | `[]` | 이 node가 실행되기 전에 완료되어야 하는 node IDs |
| `when` | string | — | condition expression입니다. false이면 node가 skip됩니다. [Condition Syntax](#when-condition-syntax) 참고 |
| `trigger_rule` | string | `all_success` | 여러 upstream이 있을 때의 join semantics |
| `context` | `'fresh'` \| `'shared'` | — | `fresh` = new session; `shared` = prior node에서 inherit. parallel layer는 기본 `fresh`, sequential은 inherited |
| `idle_timeout` | number | — | 이 milliseconds 동안 idle이면 node를 종료합니다 |
| `retry` | object | — | per-node retry configuration. [Retry Configuration](#retry-configuration) 참고 |

**AI node options** — `command`와 `prompt` node에 적용됩니다.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | inherited | per-node provider override(registered provider, 예: `'claude'`, `'codex'`) |
| `model` | string | inherited | per-node model override |
| `output_format` | object | — | structured output용 JSON Schema(Claude와 Codex) |
| `allowed_tools` | string[] | — | built-in tools whitelist. `[]` = tools 없음. Claude 전용 |
| `denied_tools` | string[] | — | 제거할 tools. `allowed_tools` 적용 후 적용됩니다. Claude 전용 |
| `hooks` | object | — | per-node SDK hook callbacks. Claude 전용. [Hooks](/guides/hooks/) 참고 |
| `mcp` | string | — | MCP server config JSON file 경로. Claude 전용. [MCP Servers](/guides/mcp-servers/) 참고 |
| `skills` | string[] | — | 미리 로드할 skills. Claude 전용. [Skills](/guides/skills/) 참고 |
| `agents` | object | — | kebab-case ID를 key로 하는 inline sub-agent definitions. Claude 전용. [Inline sub-agents](#inline-sub-agents) 참고 |
| `effort` | `'low'`\|`'medium'`\|`'high'`\|`'max'` | — | reasoning depth. Claude 전용. workflow level에서도 설정 가능 |
| `thinking` | string \| object | — | thinking mode: `'adaptive'`, `'disabled'`, 또는 `{type:'enabled', budgetTokens:N}`. Claude 전용. workflow level에서도 설정 가능 |
| `maxBudgetUsd` | number | — | USD cost cap. 초과하면 node가 실패합니다. Claude 전용. per-node only |
| `systemPrompt` | string | — | 이 node의 default `claude_code` system prompt override. Claude 전용. per-node only |
| `fallbackModel` | string | — | primary model이 실패할 때 사용할 model. Claude 전용. workflow level에서도 설정 가능 |
| `betas` | string[] | — | SDK beta feature flags(예: `'context-1m-2025-08-07'`). Claude 전용. workflow level에서도 설정 가능 |
| `sandbox` | object | — | Claude subprocess용 OS-level filesystem/network restrictions. Claude 전용. workflow level에서도 설정 가능 |

### Claude SDK 고급 옵션

이 필드들은 Claude Agent SDK options에 직접 매핑됩니다. 모두 Claude 전용입니다. Codex node는 warning을 출력하고 무시합니다. **per-node** 또는 default로 **workflow level**에 설정할 수 있으며, per-node가 우선합니다. `maxBudgetUsd`와 `systemPrompt`는 per-node only입니다.

**effort** — reasoning depth:

```yaml
- id: thorough-review
  command: review
  effort: high   # 'low' | 'medium' | 'high' | 'max'
```

**thinking** — extended thinking mode(string shorthand 또는 object form):

```yaml
- id: deep-analysis
  command: analyze
  thinking: adaptive              # 'adaptive' | 'disabled'
  # thinking: { type: enabled, budgetTokens: 8000 }  # object form
```

**maxBudgetUsd** — per-node USD cost cap(초과 시 node가 error로 실패):

```yaml
- id: expensive-step
  command: generate
  maxBudgetUsd: 2.50
```

**systemPrompt** — default `claude_code` system prompt override:

```yaml
- id: security-review
  prompt: "Review this code for vulnerabilities"
  systemPrompt: "You are a security expert specializing in TypeScript. Focus only on security issues."
```

**fallbackModel** — primary가 실패하면 다른 model 사용:

```yaml
- id: implement
  command: implement
  model: claude-opus-4-5
  fallbackModel: claude-sonnet-4-6
```

**betas** — SDK beta feature flags:

```yaml
- id: long-context-node
  command: summarize
  betas: ['context-1m-2025-08-07']
```

**sandbox** — OS-level filesystem/network 제한입니다(worktree isolation 위에 추가로 적용됩니다).

```yaml
- id: untrusted-code-analysis
  command: analyze-external
  sandbox:
    enabled: true
    network:
      allowedDomains: []
      allowManagedDomainsOnly: true
    filesystem:
      denyWrite: ['/etc', '/usr']
```

**Workflow-level default** — per-node에서 override하지 않는 한 모든 Claude node가 상속합니다.

```yaml
name: my-workflow
effort: high         # All Claude nodes use high effort by default
thinking: adaptive   # All Claude nodes use adaptive thinking
fallbackModel: claude-haiku-4-5-20251001
betas: ['context-1m-2025-08-07']
sandbox:
  enabled: true

nodes:
  - id: step1
    command: step1
    # Inherits workflow-level effort, thinking, fallbackModel, betas, sandbox

  - id: step2
    command: step2
    effort: low      # Per-node override — ignores workflow-level effort
```

### `trigger_rule` 값

| Value | Behavior |
|-------|----------|
| `all_success` | 모든 upstream dependency가 성공적으로 완료된 경우에만 실행합니다(default) |
| `one_success` | upstream dependency 중 하나 이상이 성공하면 실행합니다 |
| `none_failed_min_one_success` | 실패한 dependency가 없고 하나 이상이 성공하면 실행합니다(skipped dependency는 허용) |
| `all_done` | 모든 dependency가 terminal state(completed, failed, skipped)에 도달하면 실행합니다 |

### `when:` Condition Syntax

condition은 upstream node output을 기준으로 node 실행 여부를 gate합니다.

**String operators** — 값을 string으로 비교합니다.
```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"    # JSON dot notation for output_format nodes
```

**Numeric operators** — 양쪽 모두 number로 parse되어야 합니다. 그렇지 않으면 fail-closed 처리됩니다.
```yaml
when: "$nodeId.output > '80'"
when: "$nodeId.output >= '0.9'"
when: "$nodeId.output < '100'"
when: "$nodeId.output <= '5'"
when: "$nodeId.output.score >= '0.9'"      # dot notation + numeric comparison
```

**Compound expressions** — `&&`는 `||`보다 우선순위가 높습니다.
```yaml
when: "$a.output == 'X' && $b.output != 'Y'"
when: "$a.output == 'X' || $b.output == 'Y'"
when: "$score.output > '80' && $flag.output == 'true'"
# Precedence: (A && B) || C
when: "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'"
```

- `$nodeId.output`은 completed node의 전체 output string을 참조합니다
- `$nodeId.output.field`는 JSON field에 접근합니다(`output_format` node용)
- invalid하거나 parse할 수 없는 expression은 기본값 `false`가 됩니다(fail-closed — node는 warning과 함께 skipped)
- numeric operator는 어느 한쪽이라도 finite number가 아니면 fail-closed 처리됩니다
- parenthesis는 지원하지 않습니다. standard AND/OR precedence로 condition을 구성하세요
- skipped node는 자신의 skipped state를 dependant에 전파합니다

### `$node_id.output` 치환

node prompt와 command에서는 어떤 upstream node의 output도 참조할 수 있습니다.

```yaml
nodes:
  - id: classify
    command: classify-issue

  - id: fix
    command: implement-fix
    depends_on: [classify]
    # The command file can use $classify.output or $classify.output.field
```

Variable substitution 순서:
1. standard variables(`$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARTIFACTS_DIR` 등)
2. node output references(`$nodeId.output`, `$nodeId.output.field`)

### Structured JSON용 `output_format`

AI node에서 JSON output을 강제하려면 `output_format`을 사용하세요. Claude에서는 schema가 SDK의 `outputFormat` option으로 전달되고 `structured_output`이 직접 사용됩니다. Codex(v0.116.0+)에서는 schema가 `TurnOptions.outputSchema`로 전달되고 agent의 inline JSON response가 사용됩니다. 두 방식 모두 `when:` condition과 `$nodeId.output` substitution에 사용할 수 있는 깔끔한 JSON을 보장합니다.

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
        severity:
          type: string
          enum: [low, medium, high]
      required: [type]
```

- output은 JSON string으로 capture되며 `$classify.output`(전체 JSON) 또는 `$classify.output.type`(field access)으로 사용할 수 있습니다
- downstream node가 `when:`을 통해 특정 값으로 branch해야 할 때 `output_format`을 사용하세요

### Tool 제한용 `allowed_tools`와 `denied_tools`

prompt instruction에 의존하지 않고 node가 사용할 수 있는 built-in tool을 제한할 수 있습니다. 제한은 Claude SDK level에서 강제됩니다.

```yaml
nodes:
  - id: review
    command: code-review
    allowed_tools: [Read, Grep, Glob]   # whitelist — only these tools available

  - id: implement
    command: implement-feature
    denied_tools: [WebSearch, WebFetch] # blacklist — remove these tools

  - id: mcp-only
    command: mcp-command
    allowed_tools: []                   # empty list = disable all built-in tools
```

- `allowed_tools: []`는 모든 built-in tool을 비활성화합니다(MCP-only node에 유용). per-node MCP server를 붙이려면 node의 `mcp` field를 사용하세요. [Node Fields](#node-fields)를 참고하세요
- 둘 다 설정하면 `allowed_tools` 적용 후 `denied_tools`가 적용됩니다
- `undefined`(field 없음)와 `[]`는 의미가 다릅니다. field가 없으면 default tool set을 사용하고, `[]`는 tool 없음이라는 뜻입니다
- Claude 전용입니다. Codex node/step은 warning을 출력하고 계속 진행합니다(Codex는 per-call tool restriction을 지원하지 않음)

### Inline sub-agents

`.claude/agents/*.md` file을 작성하지 않고 workflow YAML 안에서 Claude sub-agent를 직접 정의할 수 있습니다. main agent는 `Task` tool을 통해 이들을 parallel로 spawn할 수 있습니다. 저렴한 model(예: Haiku)이 item을 brief하고 더 강한 model이 reduce하는 map-reduce pattern에 유용합니다.

```yaml
nodes:
  - id: triage
    prompt: |
      Fetch open issues via `gh issue list ...`. For each issue, spawn the
      brief-gen sub-agent in parallel (one message, multiple Task tool calls)
      to produce a 2-3 sentence brief. Then cluster briefs for duplicates.
    model: sonnet
    allowed_tools: [Bash, Read, Write, Task]
    agents:
      brief-gen:
        description: Summarises a single GitHub issue in 2-3 sentences
        prompt: |
          You are concise. Read the issue provided in the caller's prompt.
          Return JSON { summary, primarySymptom, affectedArea }.
        model: haiku
        tools: [Bash, Read]
```

Key:

- Agent ID는 반드시 **kebab-case**여야 합니다(`^[a-z0-9]+(-[a-z0-9]+)*$`)
- 각 definition에는 `description`과 `prompt`가 필요합니다. `model`, `tools`, `disallowedTools`, `skills`, `maxTurns`는 optional입니다
- map은 SDK-level agents 및 `skills:`가 만드는 internal `dag-node-skills` wrapper와 merge됩니다. ID collision이 있으면 user-defined agent가 우선합니다(이 경우 warning log가 남음)
- Claude 전용입니다. inline agent를 지원하지 않는 Codex와 community provider는 warning을 출력하고 field를 무시합니다

**`agents:`와 `.claude/agents/*.md` file 중 무엇을 쓸지:**

- **`agents:` (inline)** — sub-agent가 특정 workflow 하나의 요구에만 맞을 때 사용합니다. workflow를 single YAML file 안에 self-contained로 유지하므로 PR과 fork에서 깔끔하게 이동합니다.
- **`.claude/agents/*.md` (on-disk)** — sub-agent가 여러 workflow 또는 project 전체에서 공유될 때 사용합니다(예: 여러 maintenance workflow가 쓰는 `triage-agent`). on-disk agent는 workflow YAML 밖에 있으며 Claude Agent SDK가 자동으로 감지합니다.

두 source는 함께 사용할 수 있습니다. runtime에는 inline agent와 on-disk agent 모두 `Task(subagent_type=...)`에서 사용할 수 있습니다.

---

## Retry Configuration

모든 node는 default configuration으로 **transient** error(SDK subprocess crash, rate limit, network timeout)를 자동 retry합니다. 기본값은 **2 retries**(총 3 attempts), exponential backoff가 적용된 **3 s base delay**입니다. 각 retry attempt 전에 platform notification을 받습니다.

customize하려면 `retry:` block을 추가하세요.

```yaml
nodes:
  - id: flaky-node
    command: flaky-command
    retry:
      max_attempts: 3       # 3 retries = 4 total attempts
      delay_ms: 5000
      on_error: transient

  - id: aggressive-retry
    prompt: "Summarise the output"
    retry:
      max_attempts: 4       # 4 retries = 5 total attempts
      on_error: all         # Retry even non-transient errors (use with caution)
```

### Retry 필드

| Field | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `max_attempts` | number | `2` | 1–5 | retry attempt 수(initial attempt 제외). `1` = retry 한 번(총 2 attempts) |
| `delay_ms` | number | `3000` | 1000–60000 | 첫 retry 전 base delay(ms). attempt마다 두 배가 됩니다(exponential backoff) |
| `on_error` | `'transient'` \| `'all'` | `'transient'` | — | 어떤 error가 retry를 trigger하는지 정합니다. `'transient'` = SDK crash, rate limit, network timeout만. `'all'` = unknown error를 포함한 모든 error(auth failure 같은 FATAL error는 어떤 경우에도 retry하지 않음) |

### Error Classification

HarneesLab은 retry 여부를 결정하기 전에 error를 세 가지 bucket으로 분류합니다.

| Class | Examples | Retried by default? |
|-------|----------|---------------------|
| **FATAL** | auth failure, permission denied, credit balance exhausted | never(`on_error: all`이어도 retry하지 않음) |
| **TRANSIENT** | process crashed(`exited with code`), rate limit, network timeout | yes |
| **UNKNOWN** | 인식되지 않은 error message | no(`on_error: all`인 경우 제외) |

### Retry 알림

각 retry 전에 platform은 다음과 같은 message를 받습니다.

```
Node `node-id` failed with transient error (attempt 1/3). Retrying in 3s...
```

### Two-Layer Retry Stack

HarneesLab은 독립적인 두 retry layer를 사용합니다.

```
SDK subprocess retry (claude.ts)  — 3 total attempts, 2 s base backoff
    ↓ only if all SDK retries exhausted
Node retry (dag-executor)  — default 2 retries, 3 s base backoff
    ↓ only if all node retries exhausted
Workflow fails → next invocation auto-resumes completed nodes
```

즉, single transient crash가 node retry attempt 하나를 소비하기 전에 최대 **3 SDK retries**를 trigger할 수 있습니다.

> **DAG resume**: `nodes:`(DAG) workflow에서는 resume이 자동입니다. 다음 invocation이 이전 failed run을 감지하고 이미 completed된 node를 skip합니다. `--resume` flag는 필요 없습니다. 아래 [DAG Resume on Failure](#dag-resume-on-failure)를 참고하세요.

---

## DAG Resume on Failure

`nodes:`(DAG) workflow가 실패하면 다음 invocation이 중단된 지점부터 자동으로 resume합니다. `--resume` flag는 필요 없습니다.

**동작 방식:**

1. 각 invocation에서 HarneesLab은 같은 working path의 같은 workflow에 대해 이전 failed run이 있는지 확인합니다.
2. 찾으면 해당 run의 `node_completed` event를 load해서 어떤 node가 성공적으로 끝났는지 판단합니다.
3. completed node는 skip되고, failed node와 아직 실행되지 않은 node만 실행됩니다.
4. platform message로 `Resuming workflow — skipping 3 already-completed node(s).` 같은 알림을 받습니다.

**Crashed servers / orphaned runs**: HarneesLab은 server startup 시 `running` row를 자동으로 fail 처리하지 **않습니다**. 그렇게 하면 다른 process(CLI, adapter)에서 실제로 실행 중인 workflow를 죽일 수 있기 때문입니다. server crash로 row가 `running`에 stuck되면 dashboard에 계속 표시됩니다(Dashboard nav tab에 running workflow count가 표시됨). 명시적으로 terminal status로 전환하세요.

- **Web UI**: workflow card에서 Abandon 또는 Cancel button을 클릭하세요. Abandon은 run을 `cancelled`로 mark하고 completed-node history를 보존합니다. Cancel은 in-flight subprocess도 종료합니다.
- **CLI**: `hlab workflow abandon <run-id>`를 실행하세요(dashboard의 Abandon button과 동일). Run ID는 `hlab workflow status`에서 확인할 수 있습니다.

row가 terminal status에 도달하면 같은 path에서 같은 workflow를 다음에 invocation할 때 위 mechanism으로 completed node부터 auto-resume합니다.

> `hlab workflow cleanup [days]`와 혼동하지 마세요. 이 command는 disk hygiene을 위해 오래된 terminal run(`completed`/`failed`/`cancelled`)을 database에서 **삭제**합니다. `running` row를 전환하지는 않습니다.

**Known limitation**: 이전 node의 AI session context는 restore되지 않습니다. downstream node가 artifact가 아니라 prior run session의 in-context knowledge에 의존한다면 해당 artifact를 명시적으로 다시 읽어야 할 수 있습니다.

**Fresh start**: 이전 run에서 completed node가 하나도 없으면 Archon은 fresh start합니다(skip할 node 없음).

---

## Artifact Chain

workflow는 **artifact가 node 사이에서 data를 전달**하기 때문에 동작합니다.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Node 1          │     │ Node 2          │     │ Node 3          │
│ investigate     │     │ implement       │     │ create-pr       │
│                 │     │                 │     │                 │
│ Reads: input    │     │ Reads: artifact │     │ Reads: git diff │
│ Writes: artifact│────▶│ Writes: code    │────▶│ Writes: PR      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
  $ARTIFACTS_DIR/         src/feature.ts
  issues/issue-123.md     src/feature.test.ts
```

### Artifact Flow 설계

workflow를 만들 때는 artifact chain을 먼저 계획하세요.

| Node | Reads | Writes |
|------|-------|--------|
| `investigate-issue` | GitHub issue via `gh` | `$ARTIFACTS_DIR/issues/issue-{n}.md` |
| `implement-issue` | Artifact from `investigate-issue` | Code files, tests |
| `create-pr` | Git diff | GitHub PR |

각 command는 다음을 알아야 합니다.
- input을 어디서 찾을지
- output을 어디에 쓸지
- 어떤 format을 사용할지

---

## Model 설정

workflow는 workflow level에서 AI model과 provider-specific option을 configure할 수 있습니다.

### 설정 우선순위

model과 option은 다음 순서로 resolve됩니다.

1. **Workflow-level** - workflow YAML의 explicit setting
2. **Config defaults** - `.archon/config.yaml`의 `assistants.*`
3. **SDK defaults** - Claude/Codex SDK의 built-in default

### Provider와 Model

```yaml
name: my-workflow
provider: claude     # Any registered provider (default: from config)
model: sonnet        # Model override (default: from config assistants.claude.model)
```

**Claude models:**
- `sonnet` - 빠르고 균형 잡힌 model(recommended)
- `opus` - 강력하지만 비용이 높은 model
- `haiku` - 빠르고 lightweight한 model
- `claude-*` - full model ID(예: `claude-3-5-sonnet-20241022`)
- `inherit` - previous session의 model 사용

**Codex models:**
- 모든 OpenAI model ID(예: `gpt-5.3-codex`, `o5-pro`)
- Claude model alias는 사용할 수 없습니다

### Codex 전용 옵션

```yaml
name: my-workflow
provider: codex
model: gpt-5.3-codex
modelReasoningEffort: medium    # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
webSearchMode: live             # 'disabled' | 'cached' | 'live'
additionalDirectories:
  - /absolute/path/to/other/repo
  - /path/to/shared/library
```

**Model reasoning effort:**
- `minimal`, `low` - 빠르고 저렴합니다
- `medium` - 균형 잡힌 default
- `high`, `xhigh` - 더 철저하지만 비용이 높습니다

**Web search mode:**
- `disabled` - web access 없음(default)
- `cached` - cached search result 사용
- `live` - real-time web search

**Additional directories:**
- Codex가 codebase 밖의 file에 접근할 수 있습니다
- shared library나 documentation repo에 유용합니다
- 반드시 absolute path여야 합니다

### Web Execution Mode

기본적으로 **Web UI**에서 시작한 workflow는 background에서 실행됩니다. execution은 internal worker conversation으로 dispatch되고, result는 chat window가 아니라 workflow run log에만 표시됩니다.

workflow를 **foreground**에서 실행하려면 `interactive: true`를 설정하세요(CLI, Slack, Telegram, GitHub와 동일). 모든 AI output과 approval gate message가 user의 chat window로 직접 stream됩니다.

```yaml
name: my-interactive-workflow
interactive: true   # Web UI: foreground execution (output visible in chat)

nodes:
  - id: plan
    prompt: "Create a plan for $USER_MESSAGE"
  - id: review-gate
    approval:
      message: "Does this plan look good?"
    depends_on: [plan]
  - id: implement
    command: implement
    depends_on: [review-gate]
```

**`interactive: true`를 사용할 때:**
- **approval node**가 있는 workflow — user가 AI output을 보고 inline으로 응답해야 합니다
- **interactive loop node**(`loop.interactive: true`)가 있는 workflow — loop gate pause가 gate message와 run ID를 user에게 전달하려면 foreground execution이 필요합니다
- user가 각 step에서 feedback을 제공해야 하는 multi-turn workflow
- response가 user의 active chat thread에 표시되어야 하는 모든 workflow

**Platforms:** `interactive`는 web platform에만 영향을 줍니다. CLI, Slack, Telegram, GitHub는 이 설정과 관계없이 항상 foreground mode로 workflow를 실행합니다.

### Model Validation

workflow는 load time에 validation됩니다.
- provider/model compatibility를 확인합니다
- invalid combination은 clear error message와 함께 실패합니다
- validation error는 `/workflow list`에 표시됩니다

validation error 예시:
```
Model "sonnet" is not compatible with provider "codex"
```

### Resource Validation (CLI)

참조된 모든 command file, MCP config file, skill directory가 disk에 존재하는지 validate하려면 다음을 실행하세요.

```bash
hlab validate workflows <name>
```

이는 load-time validation이 다루는 범위를 넘어 resource resolution을 확인합니다. machine-readable output이 필요하면 `--json`을 사용하세요. 자세한 내용은 [CLI Reference](/reference/cli/)를 참고하세요.

### 예시: Config Defaults + Workflow Override

**`.archon/config.yaml`:**
```yaml
assistants:
  claude:
    model: haiku  # Fast model for most tasks
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: low
    webSearchMode: disabled
```

**override가 있는 workflow:**
```yaml
name: complex-analysis
description: Deep code analysis requiring powerful model
provider: claude
model: opus  # Override config default (haiku) for this workflow

nodes:
  - id: analyze
    command: analyze-architecture

  - id: report
    command: generate-report
    depends_on: [analyze]
    context: fresh
```

이 workflow는 config default인 `haiku` 대신 `opus`를 사용하지만, 다른 setting은 config에서 inherit합니다.

---

## Workflow Description 작성 원칙

routing과 user 이해에 도움이 되는 description을 작성하세요.

```yaml
description: |
  Investigate and fix a GitHub issue end-to-end.

  **Use when**: User provides a GitHub issue number or URL
  **NOT for**: Feature requests, refactoring, documentation

  **Produces**:
  - Investigation artifact
  - Code changes
  - Pull request linked to issue

  **Steps**:
  1. Investigate root cause
  2. Implement fix with tests
  3. Create PR
```

좋은 description에는 다음이 포함됩니다.
- workflow가 무엇을 하는지
- 언제 사용할지(그리고 언제 사용하지 말아야 하는지)
- 무엇을 produce하는지
- high-level step

---

## Variable Substitution

모든 workflow는 prompt와 command에서 variable substitution을 지원합니다. 가장 자주 쓰는 항목은 다음과 같습니다.

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` / `$USER_MESSAGE` | workflow를 trigger한 user input message |
| `$WORKFLOW_ID` | 이 workflow run의 unique ID |
| `$ARTIFACTS_DIR` | 이 workflow run을 위해 미리 생성된 artifacts directory |
| `$BASE_BRANCH` | base branch(auto-detected 또는 configured) |
| `$DOCS_DIR` | documentation directory path(default: `docs/`) |
| `$CONTEXT` | GitHub issue/PR context(사용 가능한 경우) |
| `$nodeId.output` | completed upstream node의 output |
| `$nodeId.output.field` | structured upstream node output의 JSON field |

`$LOOP_USER_INPUT`, `$REJECTION_REASON`, positional arguments, substitution order, context variable behavior를 포함한 전체 목록은 [Variable Reference](/reference/variables/)를 참고하세요.

예시:
```yaml
prompt: |
  Workflow: $WORKFLOW_ID
  Original request: $USER_MESSAGE

  GitHub context:
  $CONTEXT

  [Instructions...]
```

---

## Workflow 예시

### Quick Fix

```yaml
name: quick-fix
description: |
  Fast bug fix without full investigation.
  Use when: Simple, obvious bugs.

nodes:
  - id: fix
    command: analyze-and-fix

  - id: pr
    command: create-pr
    depends_on: [fix]
    context: fresh
```

### Investigation Pipeline

```yaml
name: fix-github-issue
description: |
  Full investigation and fix for GitHub issues.
  Use when: User provides issue number/URL

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

### Parallel Review

```yaml
name: comprehensive-pr-review
description: |
  Multi-agent PR review covering code, comments, tests, and security.

nodes:
  - id: scope
    command: create-review-scope

  - id: code-review
    command: code-review-agent
    depends_on: [scope]
    context: fresh

  - id: comment-review
    command: comment-quality-agent
    depends_on: [scope]
    context: fresh

  - id: test-review
    command: test-coverage-agent
    depends_on: [scope]
    context: fresh

  - id: security-review
    command: security-review-agent
    depends_on: [scope]
    context: fresh

  - id: synthesize
    command: synthesize-reviews
    depends_on: [code-review, comment-review, test-review, security-review]
    context: fresh
```

### Iterative Implementation (Loop Node)

```yaml
name: implement-prd
description: |
  Autonomously implement a PRD, iterating until all stories pass.

nodes:
  - id: implement-loop
    loop:
      prompt: |
        Read PRD from `.archon/prd.md`.
        Read progress from `.archon/progress.json`.
        Implement the next incomplete story with tests.
        Run validation: `bun run validate`.
        Update progress file.
        If ALL stories complete: <promise>COMPLETE</promise>
      until: COMPLETE
      max_iterations: 15
      fresh_context: true
```

### Classify and Route

```yaml
name: classify-and-fix
description: |
  Classify issue type and run the appropriate path.

  Use when: User reports a bug or requests a feature
  Produces: Code fix (bug path) or feature plan (feature path), then PR

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success

  - id: create-pr
    command: create-pr
    depends_on: [implement]
    context: fresh
```

---

## 일반적인 Pattern

### Pattern: Gated Execution

condition을 기준으로 다른 path를 실행합니다.

```yaml
name: smart-fix
description: Route to appropriate fix strategy based on issue complexity

nodes:
  - id: analyze
    command: analyze-complexity
    output_format:
      type: object
      properties:
        complexity:
          type: string
          enum: [simple, complex]
      required: [complexity]

  - id: quick-fix
    command: quick-fix
    depends_on: [analyze]
    when: "$analyze.output.complexity == 'simple'"

  - id: deep-fix
    command: deep-investigation
    depends_on: [analyze]
    when: "$analyze.output.complexity == 'complex'"
```

### Pattern: Checkpoint and Resume

긴 workflow에서는 DAG resume이 이를 자동으로 처리합니다. re-invocation 시 completed node는 skip됩니다.

```yaml
name: large-migration
description: Multi-file migration with automatic checkpoint recovery

nodes:
  - id: plan
    command: create-migration-plan

  - id: batch-1
    command: migrate-batch-1
    depends_on: [plan]
    context: fresh

  - id: batch-2
    command: migrate-batch-2
    depends_on: [batch-1]
    context: fresh

  - id: validate
    command: validate-migration
    depends_on: [batch-2]
    context: fresh
```

workflow가 `batch-2`에서 실패하면 다음 invocation은 `plan`과 `batch-1`을 자동으로 skip합니다.

### Pattern: Human-in-the-Loop

계속 진행하기 전에 human review를 위해 pause하려면 `approval` node를 사용하세요.

```yaml
name: careful-refactor
description: Refactor with human approval gate

nodes:
  - id: propose
    command: propose-refactor

  - id: review-gate
    approval:
      message: "Review the proposed refactor before proceeding. Check the artifacts directory."
    depends_on: [propose]

  - id: execute
    command: execute-approved-refactor
    depends_on: [review-gate]

  - id: pr
    command: create-pr
    depends_on: [execute]
    context: fresh
```

workflow가 `review-gate`에 도달하면 pause하고 알림을 보냅니다. 다음 방식으로 approve 또는 reject할 수 있습니다.

- **Natural language** (recommended): conversation에 response를 그대로 입력하세요. system이 paused workflow를 감지하고 auto-resume합니다
- **CLI**: `hlab workflow approve <run-id>` 또는 `hlab workflow reject <run-id>`
- **Explicit command**: `/workflow approve <run-id>` 또는 `/workflow reject <run-id>`(approval을 record합니다. resume하려면 follow-up message를 보내세요)
- **Web UI**: dashboard card의 Approve/Reject button을 클릭하세요
- **API**: `POST /api/workflows/runs/<run-id>/approve` 또는 `/reject`

natural language 또는 CLI로 approve하면 workflow는 다음 node부터 auto-resume합니다. user의 approval comment는 approval node에 `capture_response: true`가 설정된 경우에만 downstream node에서 `$review-gate.output`으로 사용할 수 있습니다.

`on_reject`가 없으면 reject 시 workflow가 cancel됩니다.
`on_reject`가 있으면 reject가 AI rework prompt를 trigger하고 re-review를 위해 다시 pause합니다.
자세한 내용은 [Approval Nodes](/guides/approval-nodes/)를 참고하세요.

### Pattern: Cancel을 사용한 Early Termination

precondition이 실패했을 때 workflow를 중지하려면 `cancel:` node를 사용하세요. downstream branch에서 compute가 낭비되는 것을 막을 수 있습니다.

```yaml
nodes:
  - id: check
    bash: "git merge-base --is-ancestor HEAD origin/main && echo ok || echo blocked"

  - id: stop-if-blocked
    cancel: "PR has merge conflicts — cannot proceed with review"
    depends_on: [check]
    when: "$check.output == 'blocked'"

  - id: review
    prompt: "Review the PR..."
    depends_on: [check]
    when: "$check.output == 'ok'"
```

`cancel:` node가 실행되면(`when:` gate 통과) reason string과 함께 workflow run을 `cancelled`로 설정하고 모든 in-flight node를 중지합니다. node failure와 달리 cancellation은 의도적인 종료이므로 status는 `failed`가 아니라 `cancelled`입니다.

### 선택 기준: Interactive Loop vs Approval with on_reject

human-in-the-loop iteration은 두 primitive로 처리합니다. pattern에 맞는 것을 선택하세요.

| | Interactive Loop | Approval + on_reject |
|---|---|---|
| YAML | `loop.interactive: true` | `approval.on_reject: { prompt }` |
| User input variable | `$LOOP_USER_INPUT` | `$REJECTION_REASON` |
| 동작 방식 | 같은 prompt가 iteration마다 실행되고 user input이 variable로 inject됩니다 | rejection 시에만 specific on_reject prompt가 실행됩니다 |
| 적합한 경우 | **Conversational iteration** — AI와 human이 오가며 explore, refine, review하는 cycle | **Gate-then-fix** — approve하면 진행하고, reject하면 특정 corrective action을 trigger |
| Approval signal | AI가 output에서 user intent를 감지합니다(`<promise>DONE</promise>`) | user가 button/command로 명시적으로 approve 또는 reject합니다 |
| Example | PIV loop: explore → user feedback → explore again | Report generation: generate → user rejects → AI revises specific section |

**Interactive loop** (`loop.interactive: true`):

```yaml
- id: refine-plan
  loop:
    prompt: |
      User's feedback: $LOOP_USER_INPUT
      Read the plan, apply feedback, present changes.
    until: PLAN_APPROVED
    max_iterations: 10
    interactive: true
    gate_message: "Review the plan. Provide feedback or say 'approved'."
```

AI는 각 iteration을 실행한 뒤 user input을 위해 pause하고, user text는 `$LOOP_USER_INPUT`을 통해 다음 iteration에 전달됩니다. AI는 user response를 바탕으로 completion signal을 언제 emit할지 결정합니다.

**Approval with on_reject** (`approval.on_reject`):

```yaml
- id: review
  approval:
    message: "Review the report. Approve or request changes."
    capture_response: true
    on_reject: { prompt: "Revise based on: $REJECTION_REASON", max_attempts: 5 }
  depends_on: [generate]
```

workflow는 approval gate에서 pause합니다. user가 approve하면 workflow가 계속됩니다. user가 feedback과 함께 reject하면 `on_reject` prompt가 `$REJECTION_REASON`과 함께 실행되고, 같은 gate에서 다시 pause합니다.

**경험칙**: human과 AI가 conversation을 하는 경우(exploring, refining, iterating)는 interactive loop를 사용하세요. human이 objection하지 않는 한 workflow가 진행되어야 한다면 `on_reject`가 있는 approval gate를 사용하세요.

---

## Workflow Debugging

### Workflow Discovery 확인

```bash
hlab workflow list
```

### Verbose Output으로 실행

```bash
hlab workflow run {name} "test input"
```

streaming output을 보며 각 step을 확인하세요.

### Artifact 확인

workflow 실행 후 해당 run의 `$ARTIFACTS_DIR`에 있는 artifact를 확인하세요(위치: `~/.archon/workspaces/owner/repo/artifacts/runs/{workflow-id}/`).

### Log 확인

workflow execution log 위치:
```
~/.archon/workspaces/owner/repo/logs/{workflow-id}.jsonl
```

각 line은 JSON event입니다(step start, AI response, tool call 등).

---

## Workflow Validation

workflow를 deploy하기 전에:

1. **각 command를 개별 test**
   ```bash
   hlab workflow run {workflow} "test input"
   ```

2. **artifact flow 확인**
   - first node가 second node가 기대하는 것을 produce하나요?
   - path가 올바른가요?
   - format이 complete한가요?

3. **edge case test**
   - input이 invalid하면 어떻게 되나요?
   - node가 실패하면 어떻게 되나요?
   - artifact가 missing이면 어떻게 되나요?

4. **iteration limit 확인**(loop용)
   - `max_iterations`가 reasonable한가요?
   - limit에 도달하면 어떻게 되나요?

---

## Summary

1. **Workflow는 command를 orchestrate합니다** — execution node의 DAG를 정의하는 YAML file입니다
2. **`nodes:`가 graph를 정의합니다** — 각 node는 command, inline prompt, bash script, loop 중 하나를 실행합니다
3. **Artifact가 접착제 역할을 합니다** — command는 in-memory context가 아니라 file을 통해 communicate합니다
4. **`context: fresh`** — node에 fresh AI session을 강제합니다(artifact만으로 동작)
5. **기본적으로 parallel입니다** — 같은 topological layer의 node는 concurrently 실행됩니다
6. **Conditional branching** — `when:` condition과 `trigger_rule`이 어떤 node가 실행될지 제어합니다
7. **`output_format`** — reliable branching을 위해 AI node의 structured JSON output을 강제합니다
8. **`allowed_tools` / `denied_tools`** — node별 tool을 제한합니다(Claude 전용, SDK-enforced)
9. **`retry:`** — transient error를 auto-retry합니다(default: 2 retries / 총 3 attempts, 3 s backoff). node별 customize 가능
10. **`hooks`** — tool control과 context injection을 위해 Claude node에 SDK hook callback을 attach합니다
11. **`mcp:`** — JSON config를 통해 per-node MCP server를 attach합니다(Claude 전용)
12. **`skills:`** — domain expertise를 위해 Claude node에 skill을 preload합니다
13. **`agents:`** — `Task` tool로 invoke할 수 있는 inline Claude sub-agent definition입니다
14. **`effort` / `thinking`** — node 또는 workflow별 reasoning depth와 thinking mode를 제어합니다(Claude 전용)
15. **`maxBudgetUsd`** — node별 USD cost cap을 설정합니다. 초과하면 error로 실패합니다(Claude 전용)
16. **`systemPrompt`** — node별 default system prompt를 override합니다(Claude 전용)
17. **`sandbox`** — node 또는 workflow별 OS-level filesystem/network restriction입니다(Claude 전용)
18. **Loop node** — completion signal까지 iterative execution하려면 DAG node 안에서 `loop:`를 사용합니다
19. **Default를 template으로 사용** — `.archon/workflows/defaults/`에서 실제 예시를 보고 복사/수정하세요
20. **철저히 test하세요** — 각 command, artifact flow, edge case를 확인하세요
