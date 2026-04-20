---
title: DAG 워크플로
description: DAG node format을 사용해 conditional branching, parallel execution, structured output routing을 갖춘 workflow를 만듭니다.
category: book
part: advanced
audience: [user]
sidebar:
  order: 8
---

[7장](/book/first-workflow/)에서는 command를 하나씩 순서대로 실행하는 workflow를 만들었습니다. 이것만으로도 계획, 구현, 검증, 리뷰 같은 많은 범위를 다룰 수 있습니다. 하지만 sequential step만으로 깔끔하게 해결하기 어려운 문제도 있습니다. "이전 결과가 feature request가 아니라 bug일 때만 이 node를 실행하라" 또는 "독립적인 reviewer 세 개가 끝날 때까지 기다렸다가 finding을 합쳐라" 같은 문제입니다.

이때 **DAG workflow**(Directed Acyclic Graph)를 사용합니다. 직선이 아니라 graph를 설명하는 방식입니다. 어떤 node가 있고, 무엇이 무엇에 의존하고, 각 node가 어떤 조건에서 실행되어야 하는지 표현합니다. Archon의 `nodes:` format이 이 graph를 제공합니다.

---

## DAG를 사용할 때

| 필요한 것 | 해결책 |
|---------------|--------------|
| 하나씩 이어지는 단순한 sequence | `depends_on`을 사용하는 sequential `nodes:` |
| 완료될 때까지 반복 | `loop:` node |
| 이전 output에 따라 node 건너뛰기 | `when:` condition |
| 분류된 input에 따라 다른 handler로 fan out | `output_format` + `when:` routing |
| 어떤 node가 무엇에 의존하는지 정확히 표현 | `depends_on` edge |
| 독립 node를 동시에 실행 | 공유 dependency가 없는 node |

workflow에 "if this, then that" branch가 필요하거나, 위에서 아래로만 흐르는 것보다 복잡한 dependency chain을 표현하고 싶다면 `nodes:`가 답입니다.

---

## 핵심 개념

### Node와 dependency

**node**는 DAG workflow에서 작업의 원자 단위입니다. 각 node에는 고유한 `id`, 실행할 대상(`command:`, `prompt:`, `bash:`), 그리고 선택적으로 의존하는 node 목록이 있습니다.

```yaml
nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-changes
    depends_on: [investigate]
```

Archon은 `investigate`가 성공적으로 완료될 때까지 `implement`를 시작하지 않습니다. `investigate`가 실패하면 `implement`는 건너뜁니다.

### 병렬 실행

공유 dependency가 없는 node는 **동시에** 실행됩니다. Archon은 node를 topological layer로 묶고 각 layer를 병렬로 실행합니다.

```yaml
nodes:
  - id: scope
    command: create-review-scope

  - id: code-review
    command: code-review-agent
    depends_on: [scope]

  - id: security-review
    command: security-review-agent
    depends_on: [scope]

  - id: synthesize
    command: synthesize-reviews
    depends_on: [code-review, security-review]
```

여기서 `code-review`와 `security-review`는 둘 다 `scope`에 의존하지만 서로에게는 의존하지 않습니다. 두 node는 병렬로 실행됩니다. `synthesize`는 둘 다 완료된 뒤 시작합니다.

### Layer

Archon은 topological layer를 자동으로 계산합니다. 여러분은 *무엇*(어떤 node, 어떤 dependency)을 설명하고, Archon은 *언제*를 계산합니다. 위 workflow에는 세 개 layer가 있습니다.

```
Layer 1: scope
Layer 2: code-review  |  security-review   (concurrent)
Layer 3: synthesize
```

layer를 명시적으로 설정하지 않습니다. `depends_on` edge에서 자연스럽게 만들어집니다.

---

## 만들어 보기: 분류하고 routing하기

### 목표

bug report나 feature request를 받아 어느 쪽인지 판단하고, 수정 또는 계획을 구현하기 전에 적절한 handler로 routing하는 workflow를 만들고 싶다고 해 봅시다.

어려운 점은 workflow를 작성하는 시점에는 어떤 branch가 필요할지 알 수 없다는 것입니다. 분류는 runtime에 일어나고 routing은 그 결과를 따라야 합니다.

### 단계별 YAML

`.archon/workflows/classify-and-route.yaml`을 만듭니다.

```yaml
name: classify-and-route
description: |
  Classify an issue as a bug or feature, then run the appropriate path.

  Use when: User reports a problem or requests a new capability.
  Produces: Code fix (bug path) or feature plan (feature path), then a PR.

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

### 실행하고 관찰하기

```bash
archon workflow run classify-and-route --branch fix/auth-issue "Users can't log in after password reset"
```

어떤 일이 일어나는지 봅시다.

1. `classify`가 실행되고 `{"type": "BUG"}`를 반환합니다.
2. `investigate`는 실행됩니다(condition passed). `plan`은 건너뜁니다(condition failed).
3. `implement`가 실행됩니다. 성공한 dependency가 하나 있으므로 `none_failed_min_one_success`를 만족합니다.
4. `create-pr`가 fresh context에서 실행됩니다.

feature request로 다시 실행합니다.

```bash
archon workflow run classify-and-route --branch feature/dark-mode "Add dark mode support"
```

이번에는 `plan`이 실행되고 `investigate`는 건너뜁니다. 같은 workflow가 두 경로를 처리합니다.

---

## Conditional execution

### `when` clause

`when:`은 node를 실행하기 전에 condition을 평가합니다. condition이 false면 node는 건너뜁니다.

```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"   # JSON field access
```

표현식이 잘못되었거나 평가할 수 없으면 Archon은 fail open합니다. 조용히 건너뛰지 않고 node를 실행합니다.

### Node output 접근

완료된 모든 node는 `$nodeId.output`으로 output을 노출합니다. `output_format`이 있는 node는 dot notation으로 개별 field에 접근할 수 있습니다.

```yaml
when: "$classify.output.type == 'BUG'"
```

downstream으로 context를 전달하기 위해 `prompt:` text 안에서 `$nodeId.output`을 직접 사용할 수도 있습니다.

```yaml
- id: report
  prompt: "Summarize the investigation findings: $investigate.output"
  depends_on: [investigate]
```

### `output_format`으로 structured output 만들기

`output_format`은 AI node의 JSON output을 강제하라고 Archon에 지시합니다. JSON Schema를 넘기면 Archon은 node가 그 shape의 data를 반환하도록 보장합니다.

```yaml
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

결과는 `$classify.output`(전체 JSON string) 또는 `$classify.output.type`, `$classify.output.severity`(개별 field)로 사용할 수 있습니다.

> **routing이 필요하면 `output_format`을 사용하세요.** 없으면 `$nodeId.output`은 plain text string이고 field access는 안정적으로 동작하지 않습니다.

### Trigger rule

node에 여러 dependency가 있고 일부가 skip될 수 있다면 `trigger_rule`이 join behavior를 제어합니다.

| 값 | 동작 |
|-------|----------|
| `all_success` | 모든 upstream dep가 성공적으로 완료된 경우에만 실행(기본값) |
| `one_success` | upstream dep 중 하나 이상이 성공적으로 완료되면 실행 |
| `none_failed_min_one_success` | 실패한 dep가 없고 하나 이상 성공하면 실행(skip된 dep는 허용) |
| `all_done` | 모든 dep가 terminal state(completed, failed, skipped)에 도달하면 실행 |

classify-and-route 예시는 `implement`에 `none_failed_min_one_success`를 사용합니다. `investigate` 또는 `plan` 중 정확히 하나가 skip되기 때문입니다. 기본값 `all_success`는 skip된 node를 success로 보지 않으므로 실패합니다.

---

## Node type

Archon은 네 가지 node type을 지원합니다.

| Type | Syntax | 사용할 때 |
|------|--------|-------------|
| **Command** | `command: my-command` | `.archon/commands/my-command.md`에서 command를 로드합니다. 표준 선택지입니다. |
| **Prompt** | `prompt: "inline instructions..."` | 재사용 command file이 필요 없는 빠른 일회성 지시. |
| **Bash** | `bash: "shell command"` | AI 없이 shell script 실행. stdout은 `$nodeId.output`으로 capture됩니다. 결정적 작업에만 사용합니다. |
| **Loop** | `loop: { prompt: "...", until: SIGNAL }` | output에 completion signal이 나타날 때까지 AI prompt를 반복합니다. [Loop Nodes](/guides/loop-nodes/)를 보세요. |

**Command**가 가장 흔합니다. 여러 workflow에서 재사용할 모든 작업에 사용하세요.

**Prompt**는 output 요약이나 data formatting처럼 logic이 단순하고 workflow-specific한 glue node에 편리합니다.

**Bash**는 test 실행, git status 확인, 파일 읽기, API fetch 같은 결정적 작업에 강력합니다. AI가 bash command를 실행하는 것이 아니라 shell이 실행합니다. output은 downstream node의 변수로 사용됩니다.

```yaml
- id: check-tests
  bash: "bun run test 2>&1 | tail -20"

- id: fix-failures
  command: fix-test-failures
  depends_on: [check-tests]
  prompt: "Test output: $check-tests.output\n\nFix any failures."
```

**Loop**는 몇 단계가 걸릴지 알 수 없는 반복 작업에 사용합니다. AI는 completion signal을 출력할 때까지 실행됩니다.

```yaml
- id: implement-stories
  loop:
    prompt: |
      Read progress from .archon/progress.json.
      Implement the next incomplete story with tests.
      Update progress. If all stories done: <promise>COMPLETE</promise>
    until: COMPLETE
    max_iterations: 20
    fresh_context: true
```

---

## Best practices

**node의 초점을 유지하세요.** 버그를 조사하는 node는 조사만 해야 합니다. 수정 구현까지 함께 하면 안 됩니다. 단일 책임은 디버깅을 쉽게 하고 conditional routing을 더 안정적으로 만듭니다.

**결정적 작업에는 `bash:`를 사용하세요.** AI에게 테스트를 실행하고 통과 여부를 말해 달라고 하지 마세요. `bash:`로 직접 테스트를 실행하고 output을 AI에 전달하세요. shell command는 재현 가능하지만, shell command에 대한 AI 요약은 그렇지 않습니다.

**routing decision에는 `output_format`을 사용하세요.** `when:` condition이 field value를 읽는 경우 upstream node에는 `output_format`이 정의되어 있어야 합니다. 없으면 free text를 pattern matching하는 것이고, 이는 취약합니다.

**먼저 단순한 input으로 테스트하세요.** 실제 data에 full workflow를 실행하기 전에 conditional의 각 branch가 올바르게 routing되는지 확인하세요. 명백한 bug인 단순 test input을 만들고 BUG path가 실행되는지 확인합니다. 그다음 명확한 feature request로 테스트합니다.

**실패는 DAG resume에 맡기세요.** 긴 workflow가 중간에 실패하면 다시 실행하세요. Archon은 이미 완료된 node를 자동으로 건너뛰고 멈춘 지점부터 재개합니다. `--resume` flag는 필요 없습니다.

---

이제 전체 DAG toolkit을 갖췄습니다. 6장과 7장에서 만든 command는 node로 그대로 동작합니다. `command:`가 그 다리입니다. 차이는 이들을 연결하는 방식입니다. 명시적 dependency, conditional path, 기본 병렬 실행을 사용할 수 있습니다.

[9장: 훅과 품질 루프 →](/book/hooks-and-quality/)에서는 다음 단계로 넘어갑니다. tool call을 가로채 guidance를 주입하고, quality gate를 만들고, node 안에서 특정 action을 거부하는 방법을 다룹니다.
