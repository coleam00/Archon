---
title: 노드별 Hooks
description: 도구 제어, 컨텍스트 주입, 입력 수정을 위해 개별 workflow node에 Claude Agent SDK hooks를 연결합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 5
---

DAG workflow node는 개별 node에 Claude Agent SDK hooks를 연결하는 `hooks` 필드를 지원합니다. Hook은 node의 AI 실행 중 발생하며 tool behavior 제어, context 주입, input 수정 등을 수행할 수 있습니다.

**Claude 전용** — Codex node는 warning을 출력하고 hooks를 무시합니다.

## 빠른 시작

```yaml
name: safe-migration
description: Generate SQL with guardrails
nodes:
  - id: generate
    prompt: "Generate a database migration for $ARGUMENTS"
    hooks:
      PreToolUse:
        - matcher: "Bash"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "No shell access during SQL generation"
```

## 동작 방식

각 hook matcher에는 세 가지 필드가 있습니다.
- `matcher`(optional): tool name으로 필터링하는 regex pattern입니다. 생략하면 모든 tool에 match됩니다.
- `response`(required): hook이 발생했을 때 반환되는 SDK `SyncHookJSONOutput`입니다.
- `timeout`(optional): hook timeout까지의 초 단위 시간입니다(기본값: 60).

runtime에는 각 YAML hook이 단순 callback으로 감싸집니다.
```
async () => response
```
custom DSL은 없습니다. `response` 자체가 SDK type이며 그대로 전달됩니다.

**중요**: `hookSpecificOutput`을 사용할 때는 event key와 일치하는 `hookEventName` 필드를 반드시 포함해야 합니다(예: `PreToolUse` hook 안의 `hookEventName: PreToolUse`). 이는 SDK 요구사항입니다. SDK는 이 필드를 사용해 어떤 event-specific field를 처리할지 결정합니다.

## 지원되는 Hook Events

| Event | Fires When | Matcher Filters On |
|-------|-----------|-------------------|
| `PreToolUse` | tool 실행 전 | Tool name(예: `Bash`, `Write`, `Read`) |
| `PostToolUse` | tool 성공 후 | Tool name |
| `PostToolUseFailure` | tool 실패 후 | Tool name |
| `Notification` | system notification | Notification type |
| `Stop` | agent 중지 | N/A |
| `SubagentStart` | subagent 생성 | Agent type |
| `SubagentStop` | subagent 종료 | Agent type |
| `PreCompact` | context compaction 전 | Trigger(`manual`/`auto`) |
| `SessionStart` | session 시작 | Source(`startup`/`resume`/`clear`/`compact`) |
| `SessionEnd` | session 종료 | Exit reason |
| `UserPromptSubmit` | user prompt 제출 | N/A |
| `PermissionRequest` | permission prompt가 표시될 시점 | Tool name |
| `Setup` | SDK initialization | Trigger(`init`/`maintenance`) |
| `TeammateIdle` | agent teammate가 idle 상태가 됨 | N/A |
| `TaskCompleted` | background task 완료 | N/A |
| `Elicitation` | MCP server가 user input 요청 | N/A |
| `ElicitationResult` | elicitation response 수신 | N/A |
| `ConfigChange` | settings/config file 변경 | Source(`user_settings`/`project_settings`/etc.) |
| `WorktreeCreate` | Git worktree 생성 | Worktree name |
| `WorktreeRemove` | Git worktree 제거 | Worktree path |
| `InstructionsLoaded` | CLAUDE.md/instructions 로드 | Memory type(`User`/`Project`/`Local`/`Managed`) |

Tool names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `Agent`, 그리고 `mcp__<server>__<action>` 형식의 MCP tools.

## Response Format (SDK `SyncHookJSONOutput`)

`response` object는 다음 필드를 지원합니다.

| Field | Type | Effect |
|-------|------|--------|
| `hookSpecificOutput` | object | Event-specific response(아래 참고) |
| `systemMessage` | string | model에 보이는 message를 주입 |
| `continue` | boolean | `false`이면 agent 중지 |
| `decision` | `'approve'` / `'block'` | Top-level approve/block |
| `stopReason` | string | 중지 이유 |
| `suppressOutput` | boolean | output emission 억제 |

### PreToolUse `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: PreToolUse
  permissionDecision: deny | allow | ask  # Control whether tool runs
  permissionDecisionReason: "..."         # Why (shown in logs)
  updatedInput:                           # Modify tool arguments
    file_path: "/sandbox/output.ts"
  additionalContext: "..."                # Text injected into model context
```

### PostToolUse `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: PostToolUse
  additionalContext: "..."         # Text injected after tool result
  updatedMCPToolOutput: ...        # Override what model sees from tool
```

### PostToolUseFailure `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: PostToolUseFailure
  additionalContext: "..."         # Context after tool failure
```

### Elicitation `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: Elicitation
  action: accept | decline | cancel  # Respond to MCP elicitation
  content: { ... }                   # Form field values
```

### ElicitationResult `hookSpecificOutput`

```yaml
hookSpecificOutput:
  hookEventName: ElicitationResult
  action: accept | decline | cancel  # Override elicitation result
  content: { ... }                   # Modified response values
```

## 예시

### tool을 완전히 거부하기

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "Shell access not allowed in this node"
```

### reason message와 함께 tool 거부하기

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "Only read operations are allowed — do not modify files"
```

### tool 사용 전 context 주입하기(blocking 없음)

참고: 이 방식은 tool을 block하지 않습니다. tool 실행 전에 model이 보는 guidance를 추가합니다.

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          additionalContext: "Only write to files in the src/ directory"
```

### file write redirect하기(tool input 수정)

```yaml
hooks:
  PreToolUse:
    - matcher: "Write"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: allow
          updatedInput:
            file_path: "/sandbox/output.ts"
```

### 모든 tool call 뒤에 steering instruction 주입하기

```yaml
hooks:
  PostToolUse:
    - response:
        systemMessage: "Check: is this output relevant to the task? If not, stop and explain why."
```

### file을 읽은 뒤 context 주입하기

```yaml
hooks:
  PostToolUse:
    - matcher: "Read"
      response:
        hookSpecificOutput:
          hookEventName: PostToolUse
          additionalContext: "You just read a file. Do NOT modify it — analysis only."
```

### shell access 시 긴급 중지

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        continue: false
        stopReason: "Emergency halt — shell access attempted"
```

### 하나의 node에 여러 hooks 적용하기

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "No shell"
    - matcher: "Write|Edit"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          additionalContext: "Only write to files in src/"
  PostToolUse:
    - response:
        systemMessage: "Verify output before continuing"
```

### 전체 workflow 예시

```yaml
name: safe-code-review
description: Review code with guardrails
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
              permissionDecisionReason: "Code review is read-only"
      PostToolUse:
        - matcher: "Read"
          response:
            hookSpecificOutput:
              hookEventName: PostToolUse
              additionalContext: "Focus on security issues in this file"

  - id: summarize
    prompt: "Summarize the review findings from $review.output"
    depends_on: [review]
    allowed_tools: []
```

## Hooks vs allowed_tools/denied_tools

| Feature | `allowed_tools`/`denied_tools` | `hooks` |
|---------|-------------------------------|---------|
| tool을 완전히 block | Yes | Yes |
| context 주입 | No | Yes (`additionalContext`, `systemMessage`) |
| tool input 수정 | No | Yes (`updatedInput`) |
| tool output override | No | Yes (`updatedMCPToolOutput`) |
| agent 중지 | No | Yes (`continue: false`) |
| tool use 후 반응 | No | Yes (`PostToolUse`) |

단순 include/exclude에는 `allowed_tools`/`denied_tools`를 사용하세요. context injection, input modification, post-tool-use reaction이 필요하면 `hooks`를 사용합니다.

## 제한사항

- **YAML에서는 static response만 가능** — hooks는 매번 같은 response를 반환합니다. conditional logic이 필요하면 downstream node의 `when:` condition을 사용하거나 structured output을 내보내는 upstream bash node로 실행을 gate하세요.
- **Claude 전용** — Codex node는 warning을 출력하고 hooks를 무시합니다.
- **hook event streaming 없음** — hook lifecycle events(`hook_started`, `hook_progress`)는 Web UI로 전달되지 않습니다.

## SDK Reference

정확한 `SyncHookJSONOutput` type, hook event reference, matcher pattern은 [Anthropic Claude Agent SDK documentation](https://docs.anthropic.com/en/docs/claude-code/sdk)을 참고하세요.

## 관련 문서

- [노드별 MCP Servers](/guides/mcp-servers/) — external tool access를 위한 `mcp:` field
- [노드별 Skills](/guides/skills/) — domain knowledge injection을 위한 `skills:` field
