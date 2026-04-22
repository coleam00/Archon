---
title: Approval 노드
description: 승인/거절 게이트로 워크플로 실행을 일시 중지하고, 거절 시 선택적으로 AI 재작업을 수행합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 4
---

DAG workflow node는 사람이 게이트를 승인하거나 거절할 때까지 실행을 일시 중지하는 `approval` 필드를 지원합니다. `approval` node를 사용하면 AI 기반 node 사이에 사람 검토 단계를 넣을 수 있습니다. 예를 들어 비용이 큰 구현 작업을 시작하기 전에 생성된 계획을 검토할 수 있습니다.

## 빠른 시작

> **Web UI 사용자:** workflow 수준에 `interactive: true`를 추가하세요. 이 값이 없으면 workflow가 background worker로 dispatch되어 approval gate 메시지가 chat window에 표시되지 않습니다. [Web 실행 모드](/guides/authoring-workflows/#web-execution-mode)를 참고하세요.

```yaml
name: plan-approve-implement
description: Plan, get approval, then implement
interactive: true   # Web UI에서 approval gate가 chat에 표시되도록 필요

nodes:
  - id: plan
    prompt: |
      Analyze the codebase and create a detailed implementation plan.
      $USER_MESSAGE

  - id: review-gate
    approval:
      message: "Review the plan above before proceeding with implementation."
    depends_on: [plan]

  - id: implement
    command: implement
    depends_on: [review-gate]
```

실행이 `review-gate`에 도달하면 workflow가 일시 중지되고 사용 중인 플랫폼(CLI, Slack, GitHub 등)으로 사용자에게 메시지를 보냅니다. **Web UI**에서는 메시지가 chat에 표시되려면 `interactive: true`가 필요합니다.

## 동작 방식

1. **일시 중지**: executor가 workflow run status를 `paused`로 설정하고 approval context(node ID와 message)를 run metadata에 저장합니다.
2. **알림 전송**: approval prompt와 승인/거절 방법이 담긴 메시지를 사용자에게 보냅니다.
3. **대기**: 사용자가 조치를 취할 때까지 workflow는 paused 상태로 유지됩니다. paused run은 worktree path guard를 잡고 있으므로 같은 경로에서 다른 workflow가 시작될 수 없습니다.
4. **승인**: 사용자가 승인하면 approval node에 대한 `node_completed` event가 기록되고 run이 재개 가능한 상태로 전환됩니다. 자연어 메시지(권장)와 CLI는 즉시 auto-resume됩니다. 명시적인 `/workflow approve` command는 승인을 기록합니다. 재개하려면 후속 메시지를 보내세요.
5. **거절**: 사용자가 거절합니다.
   - **`on_reject`가 없을 때**: workflow가 즉시 취소됩니다.
   - **`on_reject`가 있을 때**: executor가 `$REJECTION_REASON`을 치환한 뒤 `on_reject.prompt`를 AI로 실행하고, 같은 gate에서 다시 일시 중지합니다. 사용자가 승인하거나 `on_reject.max_attempts`에 도달할 때까지 반복되며, 최대 횟수에 도달하면 workflow가 취소됩니다.

## YAML 스키마

```yaml
- id: gate-name
  approval:
    message: "Human-readable prompt shown to the user"
    capture_response: true    # 선택: comment를 $gate-name.output으로 저장
    on_reject:                # 선택: 거절 시 cancel 대신 AI 재작업 실행
      prompt: "Fix based on feedback: $REJECTION_REASON"
      max_attempts: 3         # 선택: default 3, 범위 1-10
  depends_on: [upstream-node]  # 선택
  when: "$plan.output != ''"   # 선택 조건
  trigger_rule: all_success    # 선택(default: all_success)
```

### 필드

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `approval.message` | string | 예 | workflow가 일시 중지될 때 사용자에게 표시되는 메시지 |
| `approval.capture_response` | boolean | 아니요 | `true`이면 사용자의 approval comment가 downstream node에서 사용할 수 있도록 `$<node-id>.output`에 저장됩니다. 기본값: `false` |
| `approval.on_reject.prompt` | string | 아니요 | 사용자가 거절했을 때 AI로 실행할 prompt template입니다. `$REJECTION_REASON`은 reject reason으로 치환됩니다. 실행 후 workflow는 같은 gate에서 다시 일시 중지됩니다 |
| `approval.on_reject.max_attempts` | integer | 아니요 | workflow가 취소되기 전 `on_reject.prompt`가 실행될 수 있는 최대 횟수입니다. 범위: 1-10. 기본값: 3 |

Approval node는 AI agent를 호출하지 않으므로 AI 전용 필드(`model`, `provider`, `context`, `output_format`, `allowed_tools`, `denied_tools`, `hooks`, `mcp`, `skills`, `idle_timeout`)를 지원하지 않습니다. (`on_reject.prompt`는 workflow의 default provider를 사용하는 별도 AI node로 실행됩니다.)

표준 DAG 필드(`id`, `depends_on`, `when`, `trigger_rule`, `retry`)는 예상대로 동작합니다.

## 승인과 거절

### 자연어(권장)

같은 대화에 답변을 입력하기만 하면 됩니다. HarneesLab은 paused workflow를 감지하고 메시지를 approval response로 처리합니다.

```
User: "Looks good, but add error handling for the edge cases"
-> HarneesLab이 자동 승인하고, 이 메시지를 $gate.output으로 사용해 workflow를 재개합니다
   (capture_response: true일 때만 해당)
```

이 방식은 모든 플랫폼(Web, Slack, Telegram, Discord, GitHub)에서 동작합니다.

거절하려면 대신 `/workflow reject <run-id>`를 사용하세요.

### CLI

CLI는 non-interactive 방식이므로 명시적인 command를 사용합니다.

```bash
# 승인(즉시 workflow 재개)
hlab workflow approve <run-id>
hlab workflow approve <run-id> --comment "Looks good, proceed"

# 거절
# on_reject가 없으면 workflow를 취소
# on_reject가 있으면 feedback을 기록하고 AI 재작업 후 다시 일시 중지
hlab workflow reject <run-id>
hlab workflow reject <run-id> --reason "Plan needs more test coverage"
```

### 명시적 Commands(모든 플랫폼)

```
/workflow approve <run-id> looks good
/workflow reject <run-id> needs changes
```

### Web UI

Paused workflow는 dashboard에 amber pulsing badge로 표시됩니다. workflow card에서 **Approve** 또는 **Reject**를 직접 클릭하세요.

### REST API

```bash
# 승인
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Approved"}'

# 거절
curl -X POST http://localhost:3090/api/workflows/runs/<run-id>/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Needs revision"}'
```

## 하위 node 출력

기본적으로 사용자의 approval comment는 downstream에서 **사용할 수 없습니다**. `$<node-id>.output`은 빈 문자열입니다. comment를 node output으로 캡처하려면 `capture_response: true`를 설정하세요.

```yaml
nodes:
  - id: gate
    approval:
      message: "Any special instructions for implementation?"
      capture_response: true   # 사용자 comment를 $gate.output으로 사용할 수 있게 함
    depends_on: [plan]

  - id: implement
    prompt: |
      Implement the plan. User instructions: $gate.output
    depends_on: [gate]
```

`capture_response: true`가 없으면 downstream node는 `$gate.output`을 참조하지 않아야 합니다. 값이 빈 문자열이기 때문입니다.

## AI 재작업을 포함한 거절(`on_reject`)

`on_reject`가 설정되어 있으면 거절이 workflow를 취소하지 않습니다. 대신 executor가 rejection reason을 포함한 AI prompt를 실행하고 같은 gate에서 다시 일시 중지합니다.

```yaml
- id: review-gate
  approval:
    message: "Review the implementation plan."
    capture_response: true
    on_reject:
      prompt: |
        The reviewer rejected the plan with this feedback: $REJECTION_REASON

        Revise the plan to address the feedback, then summarize the changes.
      max_attempts: 3   # After 3 rejections, the workflow is cancelled. Default: 3.
  depends_on: [plan]
```

`$REJECTION_REASON` 변수는 거절한 사용자가 제공한 `--reason` text로 치환됩니다. AI 재작업 이후 workflow는 다시 일시 중지되어 reviewer가 다시 승인하거나 거절할 수 있습니다.

### on_reject 사용 시 lifecycle

1. Workflow가 approval gate에서 일시 중지됩니다
2. Reviewer가 거절합니다. `rejection_count`가 증가하고 `rejection_reason`이 저장됩니다
3. `rejection_count < max_attempts`이면 `on_reject.prompt`가 AI로 실행되고 workflow가 다시 일시 중지됩니다
4. `rejection_count >= max_attempts`이면 workflow가 취소됩니다

## 예외 상황

- **여러 approval node**: 지원됩니다. 각 node가 workflow를 독립적으로 일시 중지합니다.
- **병렬 layer의 approval**: 같은 layer의 다른 node는 정상적으로 완료됩니다. workflow는 layer boundary에서 일시 중지됩니다.
- **paused 상태에서 server restart**: run은 database에 유지됩니다. restart 후에도 사용자가 승인하거나 거절할 수 있습니다.
- **paused run 포기**: `/workflow abandon <id>` 또는 dashboard의 Abandon button을 사용하세요.

## 설계 참고

Approval node는 기존 resume infrastructure(workflow lifecycle PR #871)를 재사용합니다. 승인되면 run이 잠시 `failed` status를 거쳐 `findResumableRun`이 이를 잡을 수 있게 합니다. 이렇게 해서 resume logic 중복을 피합니다. `metadata.approval_response` 필드는 approved-then-resumed run과 실제 failed run을 구분합니다.
