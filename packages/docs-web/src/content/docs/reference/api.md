---
title: API 레퍼런스
description: Archon에 프로그래밍 방식으로 접근하기 위한 REST API endpoint입니다.
category: reference
area: server
audience: [developer]
sidebar:
  order: 6
---

Archon은 [Hono](https://hono.dev/) server를 통해 REST API를 제공하며 OpenAPI spec을 생성합니다. 모든 endpoint는 `/api/` prefix를 사용합니다.

## Base URL

기본적으로 API server는 다음 주소에서 실행됩니다.

```
http://localhost:3090/api/
```

`PORT` 환경 변수로 port를 override할 수 있습니다. worktree 안에서 실행하면 Archon이 자동으로 port를 할당합니다(range 3190-4089).

## OpenAPI Specification

Machine-readable OpenAPI 3.0 spec은 다음에서 사용할 수 있습니다.

```
GET /api/openapi.json
```

Swagger UI 같은 도구에 넣거나 typed API client 생성에 사용할 수 있습니다.

## 인증

없습니다. Archon은 단일 개발자 도구이므로 기본 API 인증을 제공하지 않습니다. Archon을 network에 노출한다면 reverse proxy나 firewall로 접근을 제한하세요.

---

## Health

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/health` | 기본 health check |
| GET | `/api/health` | API-level health check |

```bash
curl http://localhost:3090/health
# {"status":"ok"}

curl http://localhost:3090/api/health
# {"status":"ok","adapter":"...","concurrency":{...},"runningWorkflows":0}
```

---

## Conversations

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/conversations` | conversation 목록 |
| GET | `/api/conversations/{id}` | 단일 conversation 조회 |
| POST | `/api/conversations` | 새 conversation 생성 |
| PATCH | `/api/conversations/{id}` | conversation 업데이트(rename) |
| DELETE | `/api/conversations/{id}` | conversation soft-delete |
| GET | `/api/conversations/{id}/messages` | conversation의 message 목록 |
| POST | `/api/conversations/{id}/message` | conversation에 message 전송 |

### Conversation 목록

```bash
curl http://localhost:3090/api/conversations
```

Query parameter:
- `codebase_id`(optional) -- codebase 기준 filter
- `include_deleted`(optional) -- soft-deleted conversation 포함

### Conversation 생성

```bash
curl -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}'
```

선택적으로 codebase를 지정할 수 있습니다.

```bash
curl -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"codebase_id": "your-codebase-id"}'
```

생성된 conversation과 해당 `platform_conversation_id`를 반환합니다.

### Message 전송

```bash
curl -X POST http://localhost:3090/api/conversations/{id}/message \
  -H "Content-Type: application/json" \
  -d '{"message": "What does this codebase do?"}'
```

Message는 orchestrator에 비동기로 dispatch됩니다. 응답은 dispatch 확인만 의미합니다. 실제 AI 응답은 SSE streaming으로 도착하거나 messages endpoint로 polling할 수 있습니다.

### Message 조회

```bash
curl http://localhost:3090/api/conversations/{id}/messages
```

Query parameter:
- `limit`(optional) -- 반환할 message 수
- `before`(optional) -- pagination cursor

### Conversation 업데이트

```bash
curl -X PATCH http://localhost:3090/api/conversations/{id} \
  -H "Content-Type: application/json" \
  -d '{"title": "My feature discussion"}'
```

### Conversation 삭제

```bash
curl -X DELETE http://localhost:3090/api/conversations/{id}
```

Soft delete를 수행합니다. Conversation은 숨겨지지만 파괴되지는 않습니다.

---

## Codebases

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/codebases` | 등록된 codebase 목록 |
| GET | `/api/codebases/{id}` | 단일 codebase 조회 |
| POST | `/api/codebases` | codebase 등록(clone 또는 local path) |
| DELETE | `/api/codebases/{id}` | codebase 삭제 및 resource cleanup |
| GET | `/api/codebases/{id}/environments` | codebase의 isolation environment 목록 |

### Codebase 목록

```bash
curl http://localhost:3090/api/codebases
```

### Codebase 등록

URL에서 clone:

```bash
curl -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/user/repo"}'
```

Local path 등록:

```bash
curl -X POST http://localhost:3090/api/codebases \
  -H "Content-Type: application/json" \
  -d '{"path": "/home/user/projects/my-repo"}'
```

### Codebase 삭제

```bash
curl -X DELETE http://localhost:3090/api/codebases/{id}
```

Codebase registration을 제거하고 연결된 worktree와 isolation environment를 정리합니다.

### Environment 목록

```bash
curl http://localhost:3090/api/codebases/{id}/environments
```

Codebase와 연결된 isolation environment(worktree)를 반환합니다.

---

## Workflows

### Definition

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/workflows` | 사용 가능한 workflow 목록 |
| GET | `/api/workflows/{name}` | 단일 workflow definition 조회 |
| POST | `/api/workflows/validate` | workflow definition 검증(in-memory, 저장 없음) |
| PUT | `/api/workflows/{name}` | workflow 저장(create 또는 update) |
| DELETE | `/api/workflows/{name}` | user-defined workflow 삭제 |

#### Workflow 목록

```bash
curl http://localhost:3090/api/workflows
```

Query parameter:
- `cwd`(optional) -- project-specific workflow discovery에 사용할 working directory

`{ workflows: [...], errors?: [...] }`를 반환합니다. `errors` array에는 discovery 중 만난 YAML parsing failure가 들어갑니다.

#### Workflow 조회

```bash
curl http://localhost:3090/api/workflows/archon-assist
```

Query parameter:
- `cwd`(optional) -- project-specific lookup에 사용할 working directory

`{ workflow, filename, source: "project" | "bundled" }`를 반환합니다.

#### Workflow 검증

```bash
curl -X POST http://localhost:3090/api/workflows/validate \
  -H "Content-Type: application/json" \
  -d '{"definition": {"name": "my-wf", "description": "Test", "nodes": [{"id": "a", "prompt": "hello"}]}}'
```

`{ valid: true }` 또는 `{ valid: false, errors: ["..."] }`를 반환합니다. 아무것도 저장하지 않습니다.

#### Workflow 저장

```bash
curl -X PUT http://localhost:3090/api/workflows/my-workflow \
  -H "Content-Type: application/json" \
  -d '{"definition": {"name": "my-workflow", "description": "My custom workflow", "nodes": [{"id": "plan", "prompt": "Plan the feature"}]}}'
```

Query parameter:
- `cwd`(optional) -- target directory(`.archon/workflows/`가 있어야 함)

저장 전에 definition을 검증합니다. 저장된 workflow를 반환합니다.

#### Workflow 삭제

```bash
curl -X DELETE http://localhost:3090/api/workflows/my-workflow
```

User-defined workflow만 삭제할 수 있습니다. Bundled default는 제거할 수 없습니다.

### Run

| Method | Path | 설명 |
|--------|------|-------------|
| POST | `/api/workflows/{name}/run` | workflow 실행 |
| GET | `/api/workflows/runs` | workflow run 목록 |
| GET | `/api/workflows/runs/{runId}` | event 포함 run detail 조회 |
| GET | `/api/workflows/runs/by-worker/{platformId}` | worker conversation ID로 run lookup |
| POST | `/api/workflows/runs/{runId}/cancel` | 실행 중인 workflow 취소 |
| POST | `/api/workflows/runs/{runId}/resume` | 실패한 workflow resume |
| POST | `/api/workflows/runs/{runId}/abandon` | terminal이 아닌 run abandon |
| POST | `/api/workflows/runs/{runId}/approve` | paused workflow 승인 |
| POST | `/api/workflows/runs/{runId}/reject` | paused workflow 거절 |
| DELETE | `/api/workflows/runs/{runId}` | terminal run과 event 삭제 |

#### Workflow 실행

```bash
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d '{"message": "Explain the auth module", "conversationId": "conv-123"}'
```

#### 실패한 run resume

```bash
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/resume
```

Run을 auto-resume 대상으로 표시합니다. 다음 invocation에서 workflow를 다시 실행하며 이미 완료된 node는 skip합니다.

#### Paused run 승인 / 거절

```bash
# Approve (optionally with a comment)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/approve \
  -H "Content-Type: application/json" \
  -d '{"comment": "Looks good, proceed"}'

# Reject (optionally with a reason)
curl -X POST http://localhost:3090/api/workflows/runs/{runId}/reject \
  -H "Content-Type: application/json" \
  -d '{"reason": "Please add error handling first"}'
```

---

## Commands

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/commands` | 사용 가능한 command name 목록 |

```bash
curl http://localhost:3090/api/commands
```

Query parameter:
- `cwd`(optional) -- project-specific command를 위한 working directory

`{ commands: [{ name, source: "bundled" | "project" }] }`를 반환합니다.

---

## Dashboard

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/dashboard/runs` | dashboard용 enriched workflow run 목록 |

Query parameter에는 status filter, date range, pagination이 포함됩니다. Command Center UI에서 사용합니다.

---

## Configuration

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/config` | read-only configuration(safe subset) 조회 |
| PATCH | `/api/config/assistants` | assistant configuration 업데이트 |

```bash
# Read current config
curl http://localhost:3090/api/config

# Update assistant defaults
curl -X PATCH http://localhost:3090/api/config/assistants \
  -H "Content-Type: application/json" \
  -d '{"claude": {"model": "opus"}}'
```

---

## System

| Method | Path | 설명 |
|--------|------|-------------|
| GET | `/api/update-check` | 사용 가능한 update 확인(binary build only) |

`{ updateAvailable, currentVersion, latestVersion, releaseUrl }`를 반환합니다. non-binary(source) build에서는 외부 request 없이 항상 `updateAvailable: false`를 반환합니다.

---

## SSE Streaming

| Path | 설명 |
|------|-------------|
| `/api/stream/{conversationId}` | conversation의 real-time event |
| `/api/stream/__dashboard__` | 모든 conversation의 multiplexed workflow event |

이들은 Server-Sent Events(SSE) endpoint입니다. Browser의 `EventSource` 또는 SSE client로 연결합니다.

```bash
# Listen to a conversation stream
curl -N http://localhost:3090/api/stream/your-conversation-id
```

Event는 `type` field를 가진 JSON으로 encode됩니다. 전체 event type 목록은 [Web UI 문서](/adapters/web/#sse-streaming)를 참고하세요.

---

## 자주 쓰는 패턴

### Conversation 생성 후 message 전송

```bash
# 1. Create a conversation
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.platform_conversation_id')

# 2. Send a message
curl -X POST http://localhost:3090/api/conversations/$CONV_ID/message \
  -H "Content-Type: application/json" \
  -d '{"message": "/status"}'

# 3. Poll for messages
curl http://localhost:3090/api/conversations/$CONV_ID/messages
```

### API로 workflow 실행

```bash
# 1. Create a conversation scoped to a codebase
CONV_ID=$(curl -s -X POST http://localhost:3090/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"codebase_id": "your-codebase-id"}' | jq -r '.platform_conversation_id')

# 2. Start the workflow
curl -X POST http://localhost:3090/api/workflows/archon-assist/run \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"How does auth work?\", \"conversationId\": \"$CONV_ID\"}"

# 3. Monitor via SSE
curl -N http://localhost:3090/api/stream/$CONV_ID
```
