---
title: 노드별 MCP Servers
description: 외부 도구 접근을 위해 개별 workflow node에 MCP(Model Context Protocol) servers를 연결합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 6
---

DAG workflow node는 개별 node에 MCP(Model Context Protocol) servers를 연결하는 `mcp` 필드를 지원합니다. 각 node는 over-provisioning 없이 GitHub, Linear, Postgres 등 필요한 외부 도구만 받습니다.

**Claude 전용** — Codex node는 warning을 출력하고 `mcp` 필드를 무시합니다.

## 빠른 시작

1. MCP config file을 만듭니다(예: `.archon/mcp/github.json`).

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
    }
  }
}
```

2. workflow에서 이 파일을 참조합니다.

```yaml
name: triage-issues
description: Triage GitHub issues using MCP
nodes:
  - id: triage
    prompt: "List open issues and label them by priority"
    mcp: .archon/mcp/github.json
```

이것으로 끝입니다. node가 실행될 때 MCP server가 시작되고, 해당 tools가 AI에 제공되며, node가 완료되면 종료됩니다.

## Config File Format

MCP config file은 각 key가 server name이고 value가 server configuration인 JSON object입니다. 세 가지 transport type을 지원합니다.

### stdio (default)

local process를 실행합니다. 가장 흔한 type입니다.

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'stdio'` | No | 생략 시 기본값 |
| `command` | string | Yes | 실행할 executable |
| `args` | string[] | No | Command arguments |
| `env` | Record<string, string> | No | process용 environment variables |

### HTTP

remote HTTP endpoint에 연결합니다.

```json
{
  "api": {
    "type": "http",
    "url": "https://mcp.example.com/v1",
    "headers": {
      "Authorization": "Bearer $API_KEY"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'http'` | Yes | 반드시 `'http'`여야 함 |
| `url` | string | Yes | HTTP endpoint URL |
| `headers` | Record<string, string> | No | Request headers |

### SSE (Server-Sent Events)

SSE endpoint에 연결합니다.

```json
{
  "realtime": {
    "type": "sse",
    "url": "https://mcp.example.com/sse",
    "headers": {
      "Authorization": "Bearer $SSE_TOKEN"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'sse'` | Yes | 반드시 `'sse'`여야 함 |
| `url` | string | Yes | SSE endpoint URL |
| `headers` | Record<string, string> | No | Request headers |

## Environment Variable Expansion

`env`와 `headers` 필드의 값은 실행 시 `process.env`에서 확장되는 `$VAR_NAME` references를 지원합니다.

```json
{
  "db": {
    "command": "npx",
    "args": ["-y", "@mcp/server-postgres"],
    "env": {
      "DATABASE_URL": "$DATABASE_URL",
      "POOL_SIZE": "$DB_POOL_SIZE"
    }
  }
}
```

**규칙:**
- Pattern: `$UPPER_CASE_VAR` (`[A-Z_][A-Z0-9_]*`와 match)
- `env`와 `headers` 값만 확장됩니다. `command`, `args`, `url`은 그대로 둡니다
- 정의되지 않은 var는 빈 문자열로 대체되고 warning이 표시됩니다.
  `Warning: Node 'X' MCP config references undefined env vars: VAR_NAME`
- Expansion은 workflow YAML이 로드될 때가 아니라 실행 시점에 일어납니다

**왜 file-based인가요?** MCP config에는 secrets(API token, database URL)가 들어가는 경우가 많습니다. Workflow YAML file은 git에 commit됩니다. config를 별도 JSON file로 유지하면 gitignore하거나 env var reference에 의존할 수 있어 secrets가 source에 나타나지 않습니다.

## node 하나에 여러 server 사용

하나의 config file에 여러 server를 정의할 수 있습니다.

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN" }
  },
  "postgres": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres"],
    "env": { "DATABASE_URL": "$DATABASE_URL" }
  }
}
```

## Automatic Tool Wildcards

node가 MCP servers를 로드하면 tool wildcard가 `allowedTools`에 자동으로 추가됩니다. `github`, `postgres`라는 server가 있으면 node는 다음을 받습니다.

- `mcp__github__*`
- `mcp__postgres__*`

즉, 해당 server의 모든 tool을 수동으로 나열하지 않아도 즉시 사용할 수 있습니다. wildcard는 node의 기존 `allowed_tools`와 merge됩니다.

## MCP-Only Nodes

`mcp`와 `allowed_tools: []`를 결합하면 MCP tools만 사용할 수 있고 built-in tools(Bash, Read, Write 등)에는 접근하지 못하는 node를 만들 수 있습니다.

```yaml
nodes:
  - id: query-db
    prompt: "Find all users who signed up in the last 24 hours"
    mcp: .archon/mcp/postgres.json
    allowed_tools: []
```

sandboxing에 유용합니다. AI는 MCP server를 통해서만 상호작용할 수 있고 filesystem을 건드리거나 shell command를 실행할 수 없습니다.

## Connection Failure Handling

MCP server connection은 node 실행이 시작될 때 설정됩니다. server 연결에 실패하면 다음과 같은 메시지를 보게 됩니다.

```
MCP server connection failed: github (failed)
```

node는 계속 실행되지만 실패한 server의 tools 없이 실행됩니다. 이런 일이 발생하면 config file path, server command, environment variables를 확인하세요.

## Workflow 예시

### GitHub Issue Triage

```yaml
name: triage-issues
description: Fetch and label GitHub issues
nodes:
  - id: triage
    prompt: |
      List all open issues in this repo.
      For each issue, add a priority label (P0-P3) based on:
      - P0: Security vulnerabilities, data loss
      - P1: Broken core functionality
      - P2: Important but not blocking
      - P3: Nice to have
    mcp: .archon/mcp/github.json
```

### Database 기반 Code Changes

```yaml
name: schema-aware-feature
description: Build features with live database context
nodes:
  - id: inspect-schema
    prompt: "List all tables and their columns in the database"
    mcp: .archon/mcp/postgres.json
    allowed_tools: []

  - id: implement
    command: implement-feature
    depends_on: [inspect-schema]
```

### Multi-Service Orchestration

```yaml
name: full-stack-fix
description: Fix a bug using GitHub issues, database, and code
nodes:
  - id: fetch-context
    prompt: "Get issue details and related database schema"
    mcp: .archon/mcp/all-services.json
    allowed_tools: []

  - id: fix
    command: implement-fix
    depends_on: [fetch-context]

  - id: verify
    prompt: "Run the relevant query to verify the fix"
    depends_on: [fix]
    mcp: .archon/mcp/postgres.json
    allowed_tools: []
```

### Hooks를 사용한 Read-Only Analysis

MCP와 [hooks](/guides/hooks/)를 결합하면 external services를 query할 수 있지만 codebase를 수정할 수는 없는 node를 만들 수 있습니다.

```yaml
nodes:
  - id: analyze
    prompt: "Analyze our GitHub PR review patterns"
    mcp: .archon/mcp/github.json
    hooks:
      PreToolUse:
        - matcher: "Write|Edit|Bash"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "Analysis only — no code changes"
```

## Push Notifications(ntfy)

일부 built-in workflow(`archon-smart-pr-review` 등)에는 workflow가 완료되면 휴대폰으로 push notification을 보내는 optional notification node가 포함되어 있습니다. 이 node는 `when:` condition 뒤에 gate되어 있습니다. ntfy를 설정하지 않았다면 node는 조용히 skip됩니다.

### 설정(30초)

1. 휴대폰(iOS / Android)에 [ntfy app](https://ntfy.sh/)을 설치합니다
2. app을 열고 "+"를 탭한 뒤 topic name(예: `archon-yourname-a8f3x`)을 subscribe합니다. topic name은 password처럼 취급하세요. 이를 아는 사람은 누구나 notification을 보낼 수 있습니다.
3. repo에 `.archon/mcp/ntfy.json`을 만듭니다.

```json
{
  "ntfy": {
    "command": "npx",
    "args": ["-y", "ntfy-me-mcp"],
    "env": {
      "NTFY_TOPIC": "archon-yourname-a8f3x"
    }
  }
}
```

이것으로 끝입니다. 해당 file은 gitignored됩니다(`.archon/mcp/`가 `.gitignore`에 있음). 따라서 topic은 local에만 남습니다.

### workflow에서 동작하는 방식

workflow는 bash node를 사용해 config file 존재 여부를 확인합니다.

```yaml
  - id: check-ntfy
    bash: "test -f .archon/mcp/ntfy.json && echo 'true' || echo 'false'"
    depends_on: [last-work-node]

  - id: notify
    depends_on: [check-ntfy, last-work-node]
    when: "$check-ntfy.output == 'true'"
    mcp: .archon/mcp/ntfy.json
    allowed_tools: []
    prompt: |
      Send a push notification summarizing what was accomplished.
      Keep it under 2 sentences. Use priority 3.
```

`.archon/mcp/ntfy.json`이 없으면 `check-ntfy`가 `false`를 output하고, `when:` condition이 notify node를 skip하며, workflow는 이전과 동일하게 실행됩니다.

### 내 workflow에 notification 추가하기

위의 두 node(check-ntfy + notify)를 DAG workflow 끝에 추가하세요. notify node의 prompt는 의미 있는 summary를 생성하기 위해 upstream node output(예: `$synthesize.output`)을 참조해야 합니다.

### 빠른 테스트

```bash
# Verify your phone receives notifications
curl -d "Hello from Archon" ntfy.sh/YOUR_TOPIC_NAME

# Run a workflow with notifications
bun run cli workflow run archon-smart-pr-review "Review PR #123"
```

## MCP vs allowed_tools/denied_tools vs hooks

| Feature | `mcp` | `allowed_tools`/`denied_tools` | `hooks` |
|---------|-------|-------------------------------|---------|
| external tools 추가 | Yes | No | No |
| built-in tools 제거 | No | Yes | Yes |
| context 주입 | No | No | Yes |
| tool input 수정 | No | No | Yes |
| MCP only로 sandbox | `mcp` + `allowed_tools: []` | — | — |

## 제한사항

- **Claude 전용** — Codex node는 warning을 출력하고 `mcp` 필드를 무시합니다. 대신 Codex CLI config에서 MCP servers를 전역으로 설정하세요.
- **Haiku model** — Tool search(많은 tool의 lazy loading)는 Haiku에서 지원되지 않습니다. warning이 표시됩니다. MCP node에는 Sonnet 또는 Opus 사용을 고려하세요.
- **load-time validation 없음** — MCP config file은 workflow YAML이 로드될 때가 아니라 실행 시점에 읽힙니다. path typo는 node가 실행될 때까지 드러나지 않습니다.
- **inline config 없음** — MCP config는 YAML 안에 inline으로 넣을 수 없고 별도 JSON file이어야 합니다. 이는 의도된 설계입니다. version-controlled workflow file에서 secrets를 분리하기 위함입니다.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `MCP config file not found` | path가 잘못됐거나 file이 없음 | repo root(cwd) 기준 path를 확인하세요 |
| `MCP config file is not valid JSON` | JSON syntax error | `cat .archon/mcp/config.json \| python3 -m json.tool`로 검증하세요 |
| `MCP config must be a JSON object` | top-level value가 array 또는 string | `{ "server-name": { ... } }`로 감싸세요 |
| `undefined env vars: VAR_NAME` | environment variable 미설정 | 변수를 export하거나 `.env`에 추가하세요 |
| `MCP server connection failed` | server process crash 또는 URL unreachable | command/URL을 확인하고 server를 standalone으로 테스트하세요 |
| `mcp config but uses Codex` | node가 Codex provider로 resolve됨 | node에 `provider: claude`를 설정하거나 default를 바꾸세요 |
| `Haiku model with MCP servers` | Haiku가 tool search를 지원하지 않음 | 대신 `model: sonnet` 또는 `model: opus`를 사용하세요 |

## MCP Servers 찾기

자주 쓰는 integration용 popular MCP servers:

- **GitHub**: `@modelcontextprotocol/server-github`
- **PostgreSQL**: `@modelcontextprotocol/server-postgres`
- **Filesystem**: `@modelcontextprotocol/server-filesystem`
- **Slack**: `@modelcontextprotocol/server-slack`
- **Google Drive**: `@modelcontextprotocol/server-gdrive`
- **Brave Search**: `@modelcontextprotocol/server-brave-search`

전체 directory는 [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers)에서 볼 수 있습니다.
