---
title: Loop 노드
description: 완료 조건을 만족할 때까지 반복되는 AI 실행 노드를 설정합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 3
---

DAG workflow node는 완료 조건을 만족할 때까지 AI prompt를 반복 실행하는 `loop` 필드를 지원합니다. 각 iteration은 파일 읽기, 코드 작성, 명령 실행, output 생성을 할 수 있는 완전한 AI agent session입니다.

`loop` node는 자율적인 다단계 작업에 사용합니다. 예를 들어 PRD의 N개 story를 구현하거나, validation이 통과할 때까지 design을 반복 개선하거나, 품질 기준을 만족할 때까지 output을 다듬을 수 있습니다.

## 빠른 시작

```yaml
name: iterate-until-done
description: Implement stories one at a time
nodes:
  - id: setup
    bash: |
      echo "Found 3 stories to implement"

  - id: implement
    depends_on: [setup]
    loop:
      prompt: |
        Read the PRD and implement the next unfinished story.
        Validate your changes before committing.

        Setup context: $setup.output
        User request: $USER_MESSAGE

        When all stories are done, output: <promise>COMPLETE</promise>
      until: COMPLETE
      max_iterations: 10
      fresh_context: true

  - id: report
    depends_on: [implement]
    prompt: |
      Summarize what was implemented: $implement.output
```

## 동작 방식

loop node는 다음 조건 중 하나가 만족될 때까지 prompt를 반복합니다.

1. **LLM completion signal** — AI가 `<promise>SIGNAL</promise>`을 output하고 SIGNAL이 `until` 값과 일치합니다
2. **결정적 bash check** — `until_bash` script가 exit code 0으로 종료됩니다
3. **최대 iteration 도달** — 최대 반복 횟수에 도달하면 node가 명확한 error와 함께 실패합니다

각 iteration은 tool access를 가진 완전한 AI agent invocation입니다. iteration 사이에서 executor는 workflow cancellation 여부를 확인합니다.

## 설정 필드

```yaml
- id: my-loop
  loop:
    prompt: "..."           # 필수. 각 iteration에 보낼 prompt.
    until: COMPLETE         # 필수. Completion signal string.
    max_iterations: 10      # 필수. 초과하면 node 실패.
    fresh_context: true     # 선택. Default: false.
    until_bash: "..."       # 선택. 각 iteration 뒤에 확인할 bash script.
    interactive: true       # 선택. Default: false. 완료되지 않은 iteration 뒤에
                            # /workflow approve 입력을 기다림.
    gate_message: "..."     # interactive: true일 때 required. 각 pause마다 run ID와
                            # approve command와 함께 사용자에게 표시할 메시지.
```

### `prompt`

각 iteration마다 AI에 보내는 prompt text입니다. 모든 표준 variable substitution을 지원합니다.

| 변수 | 값 |
|------|----|
| `$ARGUMENTS` / `$USER_MESSAGE` | 원래 user message |
| `$ARTIFACTS_DIR` | Workflow artifacts directory |
| `$BASE_BRANCH` | Repository base branch |
| `$DOCS_DIR` | Documentation directory path(기본값: `docs/`) |
| `$WORKFLOW_ID` | 현재 workflow run ID |
| `$nodeId.output` | Upstream node의 output |
| `$LOOP_USER_INPUT` | interactive loop gate에서 `/workflow approve <id> <text>`로 제공된 user feedback입니다. resumed interactive loop의 첫 iteration에만 채워지고, 그 외 모든 iteration에서는 빈 문자열입니다. |

`fresh_context: true` loop에서는 `$USER_MESSAGE`가 특히 중요합니다. agent가 이전 iteration을 기억하지 못하므로, 작업을 이어가는 데 필요한 모든 context가 prompt에 포함되어야 합니다.

### `until`

완료 signal string입니다. executor는 각 iteration의 output에서 다음을 확인합니다.

1. **Tag format(권장):** `<promise>COMPLETE</promise>` — tags와 signal value 모두 대소문자를 구분하지 않고, whitespace에도 관대하게 match합니다. AI가 논의 중 signal word를 언급해서 생기는 false positive를 막습니다.
2. **Plain signal(fallback):** output 맨 끝의 signal(뒤따르는 whitespace와 punctuation 허용) 또는 독립된 줄의 signal입니다. false positive 가능성이 더 높으므로 tag format을 권장합니다.

`<promise>` tags는 사용자와 downstream node에 보내는 output에서 자동으로 제거됩니다.

### `max_iterations`

강제 안전 한도입니다. completion signal 없이 이 횟수에 도달하면 node는 성공이 아니라 **실패**합니다. 이를 통해 runaway loop가 token을 무기한 소모하는 일을 막습니다.

작업 범위에 따라 선택하세요.

- 단순 refinement loop: 3-5
- Multi-story implementation: 10-15
- 장시간 실행되는 autonomous agent: 15-20

### `fresh_context`

iteration 사이의 session continuity를 제어합니다.

| 값 | 동작 | 사용 시점 |
|----|------|-----------|
| `true` | 각 iteration이 fresh AI session으로 시작합니다. 이전 iteration 기억이 없습니다. | 작업 상태가 disk(files, git)에 있을 때 사용합니다. 긴 loop에서 context window exhaustion을 방지합니다. |
| `false` (default) | session이 이어집니다. 각 iteration이 이전 conversation을 resume합니다. | agent가 이전에 시도한 내용을 기억해야 하는 iterative refinement에 사용합니다. |

첫 번째 iteration은 이 설정과 관계없이 항상 fresh입니다.

### `until_bash`

각 iteration 뒤에 실행되는 선택적 bash script입니다. AI가 completion signal을 output하지 않았더라도 script가 exit code 0으로 종료되면 loop가 완료됩니다.

```yaml
loop:
  prompt: "Fix the failing tests"
  until: ALL_PASS
  max_iterations: 5
  until_bash: "bun run test"  # Loop ends when tests pass
```

test suite, lint check, build success처럼 결정적인 완료 기준에 유용합니다. bash script는 `prompt`와 같은 variable substitution(`$ARTIFACTS_DIR`, `$nodeId.output` 등)을 지원합니다. 참고: `$nodeId.output` 값은 `until_bash`에 치환될 때 shell-escaped 처리됩니다.

## 패턴

### Stateless agent(Ralph pattern)

각 iteration은 disk에서 state를 읽고, 하나의 작업 단위를 수행한 뒤, state를 다시 씁니다. prompt는 agent에게 이전 기억이 없으며 file에서 bootstrap해야 한다고 알려줍니다.

```yaml
- id: implement
  depends_on: [setup]
  idle_timeout: 600000
  loop:
    prompt: |
      You are in a FRESH session — no memory of previous iterations.
      Read the PRD tracking file to find the next unfinished story.
      Implement it, validate, commit, update tracking.
      When all stories are done: <promise>COMPLETE</promise>

      Project context: $setup.output
    until: COMPLETE
    max_iterations: 15
    fresh_context: true
```

**사용 시점:** Multi-story implementation, context window exhaustion 위험이 있는 장시간 작업에 사용합니다. agent는 `.archon/ralph/*/prd.json` 또는 유사한 tracking file을 읽어 완료된 작업과 다음 작업을 파악합니다.

### Context 누적

agent가 iteration을 거치며 이전 작업을 기반으로 이어갑니다. 이전 시도를 기억하는 것이 중요한 iterative refinement에 적합합니다.

```yaml
- id: refine
  loop:
    prompt: |
      Review the current implementation and improve it.
      Run validation after each change.
      When validation passes with zero issues: <promise>DONE</promise>
    until: DONE
    max_iterations: 5
    fresh_context: false
```

**사용 시점:** agent가 이미 시도한 내용을 기억해야 하는 fix-iterate cycle, design refinement, test-driven development에 사용합니다.

### `until_bash`를 사용한 결정적 종료

LLM 작업과 결정적 completion check를 결합합니다.

```yaml
- id: fix-tests
  loop:
    prompt: |
      Run the test suite. Read the failures. Fix them one at a time.
      If all tests pass: <promise>TESTS_PASS</promise>
    until: TESTS_PASS
    max_iterations: 8
    until_bash: "bun run test"
    fresh_context: false
```

AI가 completion을 signal하거나 bash check가 성공하면 loop가 종료됩니다. 둘 중 먼저 발생한 쪽이 적용됩니다. 이를 통해 test가 아직 실패하는데도 AI가 completion을 잘못 주장하는 일을 막습니다.

## 노드 기능

### loop node에서 동작하는 것

- `depends_on` — upstream dependencies
- `when` — conditional execution
- `trigger_rule` — join semantics
- `idle_timeout` — iteration별 timeout(기본값: 30분)
- `$nodeId.output` — downstream node는 마지막 iteration의 output을 받습니다

### `interactive`와 `gate_message`

`interactive: true`를 설정하면 iteration 사이에 loop를 일시 중지하고 사람 입력을 기다립니다. 완료되지 않은 각 iteration 뒤에 executor는 다음을 수행합니다.

1. run ID 및 `/workflow approve` command와 함께 `gate_message`를 사용자에게 보냅니다
2. workflow run을 일시 중지합니다
3. 기다립니다. 사용자가 `/workflow approve <id> <feedback>`를 실행하면 workflow가 resume됩니다

사용자의 feedback은 `$LOOP_USER_INPUT`을 통해 다음 iteration의 prompt에 주입됩니다.

> **참고**: Interactive loop node는 **workflow 수준**에도 `interactive: true`가 필요합니다. loop node에만 `interactive: true`가 있으면 loader warning이 발생하고 web background mode에서 workflow가 올바르게 일시 중지되지 않습니다.

```yaml
name: guided-refine
description: Refine output with human review between iterations.
interactive: true            # interactive loop에는 workflow level에서도 필요
nodes:
  - id: refine
    loop:
      prompt: |
        Review the current draft and improve it based on this feedback: $LOOP_USER_INPUT

        When the output is satisfactory, output: <promise>DONE</promise>
      until: DONE
      max_iterations: 5
      interactive: true
      gate_message: Review the output above. Reply with your feedback or type DONE to finish.
```

### loop node에서 지원하지 않는 것

- `retry` — parse time에 거절됩니다. loop node에 `retry:`가 설정되어 있으면 loader가 workflow를 실패 처리합니다.
- `context: fresh` — 조용히 무시됩니다. Session control은 `loop:` config 안의 `fresh_context`만으로 처리됩니다
- `hooks` — per-node SDK hooks는 loop iteration으로 전달되지 않습니다
- `mcp` — per-node MCP server configs는 loop node에 로드되지 않습니다
- `skills` — skill preloading은 loop iteration에 적용되지 않습니다
- `allowed_tools` / `denied_tools` — tool restriction은 loop iteration에서 강제되지 않습니다
- `output_format` — structured JSON output은 loop node에서 지원하지 않습니다
- `provider` / `model` — YAML에서는 error 없이 허용되지만 runtime에서는 조용히 무시됩니다. loop node는 항상 workflow-level provider와 model을 사용합니다.

이 필드들(`retry` 제외)은 parse time에 loader warning과 함께 조용히 버려집니다. workflow는 여전히 로드되지만 해당 필드는 효과가 없습니다. `retry`는 예외로, hard load error를 발생시킵니다.

loop executor는 standard node executor와 독립적으로 자체 AI session을 관리합니다. hooks, MCP, skills, tool restriction이 필요하다면 iterative logic을 command file로 감싸는 command node 사용을 고려하세요.

## 출력

loop node의 output(downstream node에서 `$nodeId.output`으로 사용 가능)은 **마지막 iteration의 output만**입니다. 모든 iteration을 이어 붙인 값이 아닙니다.

iteration 전체의 결과를 누적해야 한다면 `$ARTIFACTS_DIR`의 file에 기록하고 downstream node가 그곳에서 읽게 하세요.

## 오류 처리

| 상황 | 동작 |
|------|------|
| Iteration이 error를 throw함 | Node가 즉시 실패합니다(추가 iteration 없음) |
| `max_iterations` 초과 | Node가 설명이 포함된 error와 함께 실패합니다 |
| Workflow가 취소됨 | iteration 사이에서 감지되며 node가 중지됩니다 |
| iteration별 idle timeout | 수집된 output으로 iteration이 완료되고 loop는 다음 iteration으로 진행됩니다 |
| `retry` configured on node | parse time에 거절됩니다. workflow가 load에 실패합니다 |

## 함께 보기

- [워크플로 작성](/guides/authoring-workflows/) — 전체 workflow reference
- [노드별 Hooks](/guides/hooks/) — command/prompt node용 SDK hooks
- [노드별 MCP Servers](/guides/mcp-servers/) — external tool integration
- [노드별 Skills](/guides/skills/) — skill preloading
