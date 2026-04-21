---
title: 첫 워크플로 만들기
description: 검증, 병렬 리뷰, self-fix를 단계적으로 추가하며 다단계 workflow를 처음부터 만듭니다.
category: book
part: customization
audience: [user]
sidebar:
  order: 7
---

[6장](/book/first-command/)에서는 AI가 필요할 때 실행할 수 있는 집중된 작업인 `run-tests` command를 만들었습니다. command는 하나의 일에 훌륭합니다. workflow는 여러 command를 이어 붙이고, 여러분이 지켜보지 않아도 순서대로 자동 실행합니다.

이 장의 주제가 바로 그것입니다. 두 단계에서 시작해 하나씩 추가하면서, 계획하고 구현하고 검증하고 리뷰하고 스스로 수정하는 완전한 workflow를 처음부터 만들어 봅니다.

---

## Workflow 기본

**workflow**는 `.archon/workflows/` 안의 YAML 파일입니다. `hlab workflow run my-workflow "do something"`을 실행하면 Archon은 파일을 찾고 node를 읽은 뒤 dependency 순서대로 실행합니다.

가장 작은 유효 workflow는 다음과 같습니다.

```yaml
name: my-workflow
description: A short description of what this does

nodes:
  - id: first
    command: some-command
  - id: second
    command: another-command
    depends_on: [first]
```

이것이 전부입니다. 위쪽에는 세 개 field, 아래쪽에는 node 목록이 있습니다. 각 node에는 고유한 `id`가 필요합니다. Archon은 `.archon/workflows/` 안의 workflow file을 재귀적으로 발견하므로 원한다면 하위 디렉터리로 정리할 수 있습니다.

> **어디에 두나**: repository에 `.archon/workflows/my-workflow.yaml`을 만드세요. `hlab workflow list`를 실행해 Archon이 찾았는지 확인합니다.

---

## 버전 1: 계획하고 구현하기

실제에 가까운 것을 만들어 봅시다. 시나리오는 이렇습니다. feature request를 받아 implementation plan을 만들고, 그 계획을 구현하는 workflow가 필요합니다.

`.archon/workflows/my-workflow.yaml`을 만듭니다.

```yaml
name: my-workflow
description: Plan a feature and implement it

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
```

실행합니다.

```bash
hlab workflow run my-workflow --branch feature/auth-tokens "Add JWT refresh token support"
```

Archon은 입력값으로 `archon-create-plan`을 실행하고, 완료를 기다린 뒤 `archon-implement-tasks`를 실행합니다. AI는 planning node의 전체 대화 context를 implementation node로 가져갑니다. 자신이 무엇을 계획했는지 알고 즉시 실행할 수 있습니다.

가장 단순하면서도 유용한 workflow입니다. 두 node, 별도 configuration 없음, 여러분의 조율도 필요 없습니다.

---

## 버전 2: 검증 추가

계획과 구현에는 검증이 필요합니다. test suite를 실행하는 세 번째 node를 추가해 봅시다.

```yaml
name: my-workflow
description: Plan, implement, and validate a feature

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
  - id: validate
    command: run-tests
    depends_on: [implement]
    context: fresh
    prompt: "Run tests for the auth module"
```

여기에는 두 가지 변경이 있습니다.

**`prompt:`**는 `command:`와 함께 node에 추가 지시를 전달합니다. 여기서는 auth module에 집중하라고 알려 줍니다.

**`context: fresh`**는 이 node에서 새 AI conversation을 시작합니다. AI는 planning과 implementation node의 내용을 버리고 command instructions와 현재 코드베이스에 대한 관찰만 가지고 들어옵니다.

검증 전에 왜 fresh context를 사용할까요? implementation conversation은 AI에게 특정 부분이 잘 동작한다고 믿게 만들었을 수 있습니다. fresh context는 AI가 방금 작성한 내용을 바탕으로 통과할 것이라 가정하지 않고, 실제 현재 test result를 읽게 합니다.

> **경험칙**: 무언가를 독립적으로 검증하는 node 앞에는 `context: fresh`를 사용하세요. 필요한 것은 confirmation bias가 아니라 새로운 시선입니다.

---

## 버전 3: 병렬 리뷰 추가

검증이 통과한 뒤 PR을 만들기 전에 여러 관점으로 코드를 보는 것이 도움이 됩니다. reviewer를 하나씩 순서대로 실행하는 대신 동시에 실행할 수 있습니다.

```yaml
name: my-workflow
description: Plan, implement, validate, and review a feature

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
  - id: validate
    command: run-tests
    depends_on: [implement]
    context: fresh
    prompt: "Run tests for the auth module"
  - id: code-review
    command: archon-code-review-agent
    depends_on: [validate]
    context: fresh
  - id: error-handling
    command: archon-error-handling-agent
    depends_on: [validate]
    context: fresh
  - id: test-coverage
    command: archon-test-coverage-agent
    depends_on: [validate]
    context: fresh
```

`code-review`, `error-handling`, `test-coverage` node는 모두 `validate`에 의존하지만 서로에게는 의존하지 않습니다. Archon은 이들을 동시에 실행합니다. 각 agent는 자기만의 fresh AI session을 갖습니다. Archon은 세 node가 모두 끝날 때까지 기다린 뒤 다음 node로 이동합니다.

시간 절약 효과는 빠르게 커집니다. review agent 세 개를 병렬로 실행하면 하나를 실행하는 시간과 거의 비슷합니다. 다섯 개도 두 개 정도의 시간에 끝납니다. 병렬 실행은 workflow를 쓰는 가장 실용적인 이유 중 하나입니다.

---

## 버전 4: self-fix 추가

review agent는 문제를 찾습니다. 마지막 node는 세 review output을 모두 읽고, PR이 나가기 전에 수정할 수 있는 것을 고칩니다.

```yaml
name: my-workflow
description: Plan, implement, validate, review, and self-fix a feature

nodes:
  - id: plan
    command: archon-create-plan
  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
  - id: validate
    command: run-tests
    depends_on: [implement]
    context: fresh
    prompt: "Run tests for the auth module"
  - id: code-review
    command: archon-code-review-agent
    depends_on: [validate]
    context: fresh
  - id: error-handling
    command: archon-error-handling-agent
    depends_on: [validate]
    context: fresh
  - id: test-coverage
    command: archon-test-coverage-agent
    depends_on: [validate]
    context: fresh
  - id: self-fix
    command: archon-implement-review-fixes
    depends_on: [code-review, error-handling, test-coverage]
    context: fresh
```

`archon-implement-review-fixes` command는 세 review agent가 작성한 artifact를 읽고 finding을 종합한 뒤 권장 변경을 구현합니다. `context: fresh`는 전체 implementation history가 아니라 review finding에 집중하게 합니다.

완성된 workflow를 실행합니다.

```bash
hlab workflow run my-workflow --branch feature/auth-tokens "Add JWT refresh token support"
```

방금 `archon-idea-to-pr`의 미니 버전을 만들었습니다. 구조는 같고 더 압축되어 있습니다. 내장 workflow는 scope confirmation, PR creation, final summary 같은 node를 몇 개 더 추가하지만 핵심 패턴은 여기서 만든 것과 동일합니다.

---

## Workflow option 참조

| Option | 역할 | 사용할 때 |
|--------|-------------|-------------|
| `name` | `hlab workflow list`에서 workflow를 식별 | 필수 |
| `description` | 목록에 표시되고 router가 사용 | 필수 |
| `provider` | AI provider 설정(등록된 provider, 예: `claude`, `codex`) | 특정 provider가 필요할 때 |
| `model` | 모든 node의 model 설정(`sonnet`, `opus`, `haiku`) | config 기본값을 override하고 싶을 때 |
| `context` | `fresh`는 새 session 시작, `shared`는 이전 node에서 상속 | 검증 node 앞에서 `fresh` 사용 |
| `depends_on` | 이 node가 실행되기 전에 완료되어야 하는 node ID 목록 | 순서와 fan-in 표현 |
| `idle_timeout` | node별 idle timeout, millisecond 단위(기본: 5분) | 오래 실행되는 node |

이 option들은 node level(`nodes:` 내부)에 적용됩니다. `provider`와 `model`은 YAML 최상위에도 설정할 수 있으며, 그러면 모든 node에 적용됩니다.

**node별 model override:**
```yaml
nodes:
  - id: plan
    command: archon-create-plan
    model: opus        # use the more capable model for planning

  - id: validate
    command: run-tests
    depends_on: [plan]
    model: haiku       # fast and cheap for a mechanical check
    context: fresh
```

---

## Conditional을 추가할 때

지금까지 사용한 `nodes:` format은 대부분의 workflow를 다룰 수 있습니다. 여기에 conditional routing을 추가하려면 `when:` condition과 `output_format`을 추가합니다.

| 필요 | 해결책 |
|------|----------|
| 이전 node output에 따라 node 건너뛰기 | `when:` condition |
| 분류된 input에 따라 다른 handler로 fan out | `output_format` + `when:` routing |
| upstream 중 하나 이상 성공했을 때만 node 실행 | `trigger_rule: one_success` |
| signal이 나타날 때까지 작업 반복 | `loop:` node type |

workflow에 "if this, then that" branch가 필요해지거나 한 node의 structured JSON output을 다른 node로 routing해야 한다면, 다음 장에서 다루는 기능을 사용하면 됩니다.

[8장: DAG 워크플로 →](/book/dag-workflows/)에서는 conditional, structured output routing, trigger rule을 다룹니다. command와 node에 대해 배운 내용은 그대로 이어집니다.
