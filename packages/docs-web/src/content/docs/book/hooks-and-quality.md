---
title: 훅과 품질 루프
description: node 실행 중 tool call을 가로채 guidance를 주입하거나 action을 차단하거나 feedback loop를 만듭니다.
category: book
part: advanced
audience: [user]
sidebar:
  order: 9
---

[8장](/book/dag-workflows/)에서는 graph를 통해 작업을 routing하는 법을 배웠습니다. 분류하고, branch를 나누고, 병렬화했습니다. 하지만 routing은 *어떤* node가 *어떤 순서*로 실행되는지만 제어합니다. node가 실행되기 시작하면 AI는 혼자 움직입니다. 파일을 읽고, 코드를 쓰고, command를 실행하고, 여러분은 결과를 사후에 보게 됩니다.

**Hook**은 이것을 바꿉니다. hook은 *node가 실행되는 동안* tool call을 전후로 가로채 guidance를 주입하거나 action을 차단하거나 feedback loop를 만들 수 있게 합니다. prompt를 다시 쓰는 것이 아닙니다. AI가 일하는 옆에 서서 실시간으로 교정 신호를 주는 방식입니다.

> **Claude only** — hook은 Claude Agent SDK 기능입니다. Codex node는 warning을 내고 정의된 hook을 건너뜁니다.

---

## Hook이 하는 일

AI가 `Read`, `Write`, `Edit`, `Bash` 또는 MCP tool 같은 도구를 사용할 때마다 hook이 실행될 수 있습니다. 가로챌 수 있는 시점은 두 가지입니다.

- **PreToolUse**: tool 실행 전에 동작합니다. 허용, 거부, input 수정, 진행 전 model이 볼 context 주입을 할 수 있습니다.
- **PostToolUse**: tool이 성공적으로 완료된 뒤 동작합니다. model이 결과를 처리할 때 볼 context를 주입할 수 있습니다.

hook은 workflow YAML에서 node별로 정의합니다. 해당 node 실행 중에만 적용됩니다.

```yaml
nodes:
  - id: implement
    command: implement-changes
    hooks:
      PreToolUse:
        - matcher: "Write|Edit"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              additionalContext: "Only write to files in src/. Do not modify tests."
```

`matcher`는 tool name에 대해 적용되는 regex입니다. `Write|Edit`는 둘 중 하나에 match합니다. matcher를 생략하면 모든 tool call에서 실행됩니다.

---

## Hook type

### PreToolUse

tool 전에 실행됩니다. 세 가지 response style을 지원합니다.

**context 주입** — tool 실행 전에 model이 볼 guidance를 추가합니다. tool을 차단하지는 않습니다.

```yaml
PreToolUse:
  - matcher: "Bash"
    response:
      hookSpecificOutput:
        hookEventName: PreToolUse
        additionalContext: "Before running any command, confirm it's read-only"
```

**tool 거부** — 이 tool call을 완전히 중단합니다.

```yaml
PreToolUse:
  - matcher: "Bash"
    response:
      hookSpecificOutput:
        hookEventName: PreToolUse
        permissionDecision: deny
        permissionDecisionReason: "Shell access not allowed in this node"
```

**input 수정** — tool이 동작하는 위치를 바꿉니다.

```yaml
PreToolUse:
  - matcher: "Write"
    response:
      hookSpecificOutput:
        hookEventName: PreToolUse
        permissionDecision: allow
        updatedInput:
          file_path: "/sandbox/output.ts"
```

### PostToolUse

tool이 완료된 뒤 실행됩니다. model이 결과를 처리할 때 볼 context를 추가하는 데 사용합니다.

```yaml
PostToolUse:
  - matcher: "Read"
    response:
      hookSpecificOutput:
        hookEventName: PostToolUse
        additionalContext: "You just read this file. Do not modify it — analysis only."
```

### Matchers

`matcher` field는 tool name에 match되는 regex입니다. 자주 쓰는 pattern은 다음과 같습니다.

| Matcher | match 대상 |
|---------|---------|
| `"Write"` | `Write` tool만 |
| `"Write\|Edit"` | `Write` 또는 `Edit` |
| `"Bash"` | `Bash` tool |
| `"Read"` | `Read` tool |
| *(생략)* | 모든 tool call |

---

## 예시: self-review loop

command를 바꾸지 않고 품질 압력을 만드는 pattern입니다. 파일 write나 edit가 일어날 때마다 hook이 model에게 결과를 다시 읽고 검증하라는 reminder를 보게 합니다.

```yaml
name: implement-with-self-review
description: Implement changes with automatic post-write review prompts.

nodes:
  - id: implement
    command: implement-changes
    hooks:
      PostToolUse:
        - matcher: "Write|Edit"
          response:
            hookSpecificOutput:
              hookEventName: PostToolUse
              additionalContext: |
                You just modified a file. Before continuing:
                1. Re-read the file you just changed
                2. Run the type checker: bun run type-check
                3. If there are errors, fix them before proceeding

  - id: validate
    command: validate-changes
    depends_on: [implement]
```

`implement` node가 파일을 쓰거나 수정할 때마다 model은 tool result의 일부로 이 reminder를 봅니다. model이 반드시 따르리라는 보장은 없지만, command 자체에 이를 인코딩하지 않아도 일관된 품질 압력을 줍니다.

이것이 "quality loop"의 의미입니다. 각 write가 review prompt를 촉발하고, 그 review가 다른 write를 촉발할 수 있으며, 다시 review가 이어집니다. loop는 model이 만족하거나 step이 완료될 때까지 단일 node 안에서 실행됩니다.

---

## 예시: permission denial

일부 node는 특정 일을 하면 안 됩니다. PR creation node가 코드를 수정하면 안 됩니다. code review node는 shell command를 실행하거나 파일을 쓰면 안 되고, 읽고 보고해야 합니다.

```yaml
name: safe-code-review
description: Review code without modifying it.

nodes:
  - id: fetch-diff
    bash: "git diff main...HEAD"

  - id: review
    prompt: "Review this diff for bugs and security issues: $fetch-diff.output"
    depends_on: [fetch-diff]
    hooks:
      PreToolUse:
        - matcher: "Bash"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "Code review should not execute commands"
        - matcher: "Write|Edit"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "Code review is read-only — do not modify files"
```

`review` node는 context 이해를 위해 파일을 읽을 수 있지만 command를 실행하거나 무언가를 쓸 수는 없습니다. 시도하면 tool call이 차단되고 model은 이유를 봅니다. node의 operating envelope을 prompt 어딘가에 묻어 둔 것이 아니라 YAML에 정의한 것입니다.

---

## 설계 pattern

**Quality gate** — write 후 정확성을 검증하라는 reminder(type check, lint, re-read)를 주입합니다. 단일 node 안에 self-correcting loop를 만듭니다.

**Guardrail** — 해당 node에서 사용하면 안 되는 tool을 거부합니다. planning node가 `Bash`를 실행할 이유는 없습니다. summarization node가 `Write`를 호출할 이유도 없습니다. 이런 제약을 명시적으로 인코딩하세요.

**Context injection** — tool 실행 전에 관련 guidance를 주입합니다. "migration file을 읽으려 합니다. column rename은 additive해야 함을 기억하세요." 같은 내용입니다. 긴 prompt의 맨 위에 묻히지 않고 적절한 순간에 model이 보게 됩니다.

**Audit trail** — `PostToolUse`의 `systemMessage`를 사용해 model이 action을 정당화하도록 요청합니다. "방금 무엇을 왜 바꿨는지 설명하세요." 같은 방식입니다. 이 정당화는 conversation history의 일부가 됩니다.

---

## 참조: hook schema

hook entry에는 세 field가 있습니다.

| Field | 필수 | 설명 |
|-------|----------|-------------|
| `matcher` | 아니요 | tool name에 match되는 regex. 생략하면 모든 tool에 match합니다. |
| `response` | 예 | hook response object(아래 참조). |
| `timeout` | 아니요 | hook timeout까지의 초. 기본값: 60. |

`response` object의 top-level field:

| Field | Type | 효과 |
|-------|------|--------|
| `hookSpecificOutput` | object | event별 response(PreToolUse, PostToolUse 등) |
| `systemMessage` | string | model이 볼 수 있는 message 주입 |
| `continue` | boolean | `false`면 agent를 완전히 중단 |
| `decision` | `'approve'` / `'block'` | top-level approve/block |
| `stopReason` | string | 중단 시 표시되는 이유 |

`PreToolUse` hook-specific output:

| Field | 효과 |
|-------|--------|
| `hookEventName: PreToolUse` | 필수. event type을 식별 |
| `permissionDecision: deny\|allow\|ask` | tool 실행 여부 제어 |
| `permissionDecisionReason` | log와 model에 표시되는 이유 |
| `additionalContext` | model context에 주입되는 text(차단하지 않음) |
| `updatedInput` | tool argument override(예: file path redirect) |

`PostToolUse` hook-specific output:

| Field | 효과 |
|-------|--------|
| `hookEventName: PostToolUse` | Required |
| `additionalContext` | tool result 후 주입되는 text |

> **여러 hook**: 같은 event 아래에 여러 matcher를 정의할 수 있습니다. matcher가 match되면 모두 실행됩니다. 한 node에 `PreToolUse`와 `PostToolUse` hook을 동시에 활성화할 수 있습니다.

> **Hook vs `allowed_tools`**: 단순 include/exclude에는 `allowed_tools`/`denied_tools`를 사용하세요. context injection, input modification, tool 실행 후 reaction이 필요하면 hook을 사용하세요.

---

이제 전체 toolkit을 갖췄습니다. 작업을 정의하는 command, 이를 오케스트레이션하는 workflow, 조건부 routing을 담당하는 DAG graph, 실시간으로 행동을 조정하는 hook까지 다뤘습니다.

[10장: 빠른 참조 →](/book/quick-reference/)는 모든 CLI command, variable, YAML option을 한눈에 볼 수 있게 모아 둔 페이지입니다.
