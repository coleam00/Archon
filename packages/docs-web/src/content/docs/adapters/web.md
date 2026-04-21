---
title: Web UI
description: Archon과 상호작용하는 내장 웹 인터페이스입니다. 토큰이나 외부 서비스가 필요 없습니다.
category: adapters
area: adapters
audience: [user]
status: current
sidebar:
  order: 1
---

Web UI는 Archon과 상호작용하기 위한 내장 인터페이스입니다. 토큰, API key, 외부 서비스가 필요 없습니다. 서버를 시작하고 브라우저를 열면 됩니다.

## 사전 준비

- HarneesLab 설치 및 dependency 설치 완료(`bun install`)
- Anthropic API key 또는 Claude Code 인증([AI 어시스턴트](/getting-started/ai-assistants/) 참고)

## Web UI 시작

**개발 모드(권장):**

```bash
# Start both backend + frontend with hot reload
bun run dev
# Web UI: http://localhost:5173
# API server: http://localhost:3090
```

각 구성요소를 개별적으로 시작할 수도 있습니다.

```bash
# Backend API server only (port 3090)
bun run dev:server

# Frontend dev server only (port 5173, requires backend running)
bun run dev:web
```

**프로덕션:**

```bash
bun run build    # Build the frontend into static files
bun run start    # Server serves both API and Web UI on port 3090
```

프로덕션 모드에서는 backend가 같은 port(3090)에서 compiled frontend를 제공합니다. 따라서 별도의 frontend URL이 없습니다.

**원격 / homelab 접근:**

backend는 기본적으로 `0.0.0.0`에 bind합니다. Vite dev server는 `localhost`에서만 listen합니다. 네트워크에서 frontend를 노출하려면 다음을 실행합니다.

```bash
bun run dev:web -- --host 0.0.0.0
```

그다음 `bun run dev:server`로 backend를 별도로 시작합니다. Web UI는 `http://<server-ip>:5173`에서 접근할 수 있습니다. firewall에서 5173과 3090 port를 허용해야 합니다.

## UI 레이아웃

Web UI는 dark theme의 single-page application이며 네 가지 주요 영역으로 구성됩니다.

### 왼쪽 sidebar

- **Conversations list** -- 모든 chat conversation을 보여주며, 검색 가능하고 project별로 그룹화됩니다. 클릭해서 전환하고, 오른쪽 클릭 또는 hover로 이름 변경/삭제를 할 수 있습니다.
- **Project selector** -- 등록된 codebase가 여기에 표시됩니다. project를 선택하면 conversation과 workflow 범위가 해당 repository로 제한됩니다. 새 project를 등록(URL에서 clone 또는 local path 등록)하고 기존 project를 제거할 수도 있습니다.
- **Workflow invoker** -- workflow 실행용 quick-launch panel입니다. dropdown에서 workflow를 선택하고 메시지를 입력한 뒤 Run을 누릅니다. 이 동작은 새 conversation을 만들고 workflow를 한 번에 시작합니다.

### 메인 chat 영역

화면 중앙은 chat interface입니다. 여기서 AI 어시스턴트와 상호작용합니다. 일반 chat application처럼 동작하지만 coding workflow에 특화된 기능이 추가되어 있습니다.

### Command Center(Dashboard)

`/dashboard` route에서 접근할 수 있는 Command Center는 project 전체의 workflow run을 보여줍니다. 포함되는 항목은 다음과 같습니다.

- **Status summary bar** -- running, completed, failed, paused workflow 수
- **Workflow run cards** -- 각 run의 status, workflow name, elapsed time, node progress
- **Actions** -- dashboard에서 직접 run을 resume, cancel, abandon, approve, reject
- **History table** -- date range filtering이 가능한 paginated past run 목록

### Settings

`/settings` page에서는 YAML 파일을 직접 편집하지 않고 assistant 기본값(model, provider)을 설정할 수 있습니다. codebase를 등록하고 관리하는 **Projects** 섹션도 포함합니다.

## Chat interface

### Conversation 만들기

sidebar의 "New Chat" 버튼을 클릭하거나 workflow invoker를 사용해 즉시 workflow를 시작하는 conversation을 만듭니다. 각 conversation에는 고유 ID가 부여되며 page refresh 후에도 유지됩니다.

sidebar에서 project가 선택되어 있으면 새 conversation은 자동으로 해당 codebase 범위에 묶입니다.

### 메시지 보내기

아래쪽 message input에 입력하고 Enter를 누르거나 Send를 클릭합니다. 메시지는 다음과 같을 수 있습니다.

- **자연어** -- AI 어시스턴트가 대화형으로 응답하며 tool을 사용해 code를 탐색하고 수정합니다.
- **Slash commands** -- `/status`, `/workflow list`, `/help` 등입니다. AI 없이 deterministic하게 처리됩니다.
- **Workflow triggers** -- "fix issue #42" 또는 "review this PR" 같은 메시지는 적절한 workflow로 자동 route됩니다.

### AI 응답과 tool call

AI 응답은 real-time으로 stream됩니다. 어시스턴트가 tool(파일 읽기, 명령 실행, 코드 편집)을 사용하면 각 tool call이 접을 수 있는 card로 표시되며 다음을 보여줍니다.

- tool name과 input arguments
- tool output 또는 result
- chat 가독성을 유지하기 위한 expand/collapse 기능

agent가 작업 중일 때는 **lock indicator**가 나타나므로, 언제 다음 메시지를 보내도 되는지 알 수 있습니다.

### Connection status

UI의 status indicator는 backend로 향하는 SSE connection이 활성 상태인지 보여줍니다. "disconnected"가 보이면 backend가 실행 중인지 확인하고 page를 새로고침하세요.

## Workflow 실행

### Workflow 실행하기

Web UI에서 workflow를 실행하는 방법은 세 가지입니다.

1. **Sidebar workflow invoker** -- workflow를 선택하고 메시지를 입력한 뒤 Run을 클릭합니다.
2. **Chat message** -- 원하는 작업을 설명하면 router가 적절한 workflow를 고릅니다(예: "review PR #123").
3. **Slash command** -- 명시적으로 실행하려면 `/workflow run <name> <message>`를 사용합니다.

### Foreground 실행과 background 실행

기본적으로 workflow는 background에서 실행됩니다. workflow가 별도의 worker conversation에서 실행되는 동안 conversation에는 progress card가 표시됩니다. 사용자는 계속 chat하거나 다른 workflow를 시작할 수 있습니다.

YAML definition에 `interactive: true`가 있는 workflow는 foreground에서 실행됩니다. approval gate 또는 interactive loop node가 있는 workflow는 사용자가 real-time으로 approve/reject해야 하므로 이 설정이 필요합니다.

### Workflow progress card

workflow가 실행되는 동안 conversation에는 다음 정보를 보여주는 progress card가 나타납니다.

- 현재 status(running, completed, failed, paused)
- 현재 실행 중인 DAG node
- node별 status indicator
- elapsed time

paused workflow(approval gate)의 경우 progress card에 **Approve**와 **Reject** 버튼이 표시되어 chat에서 직접 workflow를 제어할 수 있습니다.

### Workflow result card

workflow가 terminal state(completed, failed, cancelled)에 도달하면 progress card는 conversation 안에서 result card로 대체됩니다. result card는 다음을 보여줍니다.

- **Status icon** -- completed, failed, cancelled를 나타내는 visual indicator
- **Header** -- 결과에 따라 "Workflow complete", "Workflow failed", "Workflow cancelled"
- **Node count** -- terminal state에 도달한 전체 node 중 완료된 node 수(예: `3/4 nodes`)
- **Duration** -- run의 total elapsed time
- **Artifacts** -- workflow가 생성한 file 또는 output과 direct link

result card header의 arrow button을 클릭하면 전체 execution detail page가 열립니다.

### Execution detail page

dashboard 또는 progress card에서 workflow run을 클릭하면 `/workflows/runs/:runId`의 execution detail page가 열립니다. 이 page는 다음을 보여줍니다.

- node별 status가 표시된 전체 DAG graph
- 각 node의 step-by-step log
- workflow가 생성한 artifact
- run을 resume, cancel, abandon하는 action

## Workflow Builder

`/workflows/builder`의 Workflow Builder는 workflow YAML 파일을 만들고 수정하는 visual editor를 제공합니다. 기능은 다음과 같습니다.

- **DAG canvas** -- node를 drag-and-drop해 workflow graph를 시각적으로 구성합니다.
- **Node palette** -- sidebar library에서 command, prompt, bash, loop node를 추가합니다.
- **Node inspector** -- node를 클릭해 tabbed panel에서 속성(command, prompt text, dependencies, model overrides, hooks, MCP servers 등)을 설정합니다.
- **View modes** -- Visual, Split, Code view를 전환합니다. Split mode는 canvas와 YAML을 나란히 보여줍니다.
- **Command picker** -- command node 설정 시 사용 가능한 command를 탐색합니다.
- **Validation panel** -- 구성 중 real-time validation feedback을 제공합니다.
- **Undo/redo** -- keyboard shortcut을 포함한 전체 undo/redo stack을 제공합니다.
- **Save** -- workflow YAML을 project의 `.archon/workflows/` directory에 저장합니다.

`/workflows` page에서 기존 workflow를 탐색하고, builder에서 열어 편집할 수도 있습니다.

## SSE Streaming

Web UI는 backend와 real-time으로 통신하기 위해 Server-Sent Events(SSE)를 사용합니다. conversation을 열면 frontend는 `/api/stream/:conversationId`에 persistent connection을 엽니다.

SSE로 stream되는 event는 다음과 같습니다.

| Event Type | 설명 |
|------------|-------------|
| `text` | AI response text(성능을 위해 batched) |
| `tool_call` | argument가 포함된 tool invocation |
| `tool_result` | tool execution result |
| `workflow_step` | workflow node status change |
| `workflow_status` | 전체 workflow run status update |
| `workflow_dispatch` | 이 conversation에서 workflow 시작 |
| `dag_node` | DAG node progress update |
| `workflow_artifact` | workflow가 생성한 artifact |
| `conversation_lock` | lock/unlock indicator |
| `session_info` | session metadata |
| `error` | error message |
| `heartbeat` | keep-alive signal |

별도의 dashboard SSE stream인 `/api/stream/__dashboard__`는 모든 conversation의 workflow event를 multiplex하여 Command Center의 live update를 구동합니다.

## Project와 codebase

### Project 등록

Web UI에서는 세 가지 방식으로 codebase를 등록할 수 있습니다.

1. **Add Project input** -- sidebar에서 **+**를 클릭하거나 **Settings → Projects**로 이동해 GitHub URL 또는 local path를 입력합니다. `https://`, `ssh://`, `git@`, `git://`로 시작하는 입력은 remote URL로 처리되어 clone되고, 그 외 입력은 local path로 처리되어 제자리에서 등록됩니다.
2. **Chat에서 URL clone** -- chat에서 `/clone <url>` command를 사용하거나, API로 `/api/codebases`에 `url` field를 담아 POST합니다.
3. **API로 local path 등록** -- 기존 git repository를 가리키는 `path` field를 담아 `/api/codebases`에 POST합니다.

등록된 codebase는 sidebar의 project selector에 표시됩니다.

### Project 전환

sidebar에서 project를 클릭하면 conversation과 workflow 범위가 해당 codebase로 제한됩니다. 선택한 project는 다음을 결정합니다.

- 어떤 `.archon/commands/`와 `.archon/workflows/`가 로드되는지
- AI tool execution의 working directory
- 어떤 worktree와 isolation environment가 표시되는지

### Project 제거

sidebar에서 project에 hover한 뒤 delete icon을 클릭하거나, API로 `/api/codebases/:id`에 DELETE 요청을 보냅니다. 이 작업은 등록만 제거하며 clone된 file은 삭제하지 않습니다.

## 더 읽기

- [시작하기](/getting-started/overview/) -- 전체 설정 가이드
- [설정](/getting-started/configuration/) -- project에 맞게 HarneesLab 사용자화
- [Workflow 작성](/guides/authoring-workflows/) -- custom workflow 만들기
- [API Reference](/reference/api/) -- 전체 REST API 문서
