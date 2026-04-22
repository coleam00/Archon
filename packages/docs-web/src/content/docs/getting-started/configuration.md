---
title: 설정
description: API key, assistant, project setting으로 HarneesLab을 설정합니다.
category: getting-started
area: config
audience: [user, operator]
sidebar:
  order: 3
---

## 환경 변수

아래 값들은 shell 또는 `.env` 파일에 설정합니다.

| 변수 | 필수 | 설명 |
|----------|----------|-------------|
| `CLAUDE_BIN_PATH` | 예(binary builds) | Claude Code executable 또는 SDK `cli.js`에 대한 절대 경로입니다. `assistants.claude.claudeBinaryPath`가 설정되지 않은 compiled HarneesLab binary에서는 필수입니다. Dev mode(`bun run`)에서는 `node_modules`를 통해 자동으로 해석됩니다. |
| `CLAUDE_USE_GLOBAL_AUTH` | 아니요 | `claude /login`의 credential을 사용하려면 `true`로 설정합니다(다른 Claude token이 없을 때 기본값) |
| `CLAUDE_CODE_OAUTH_TOKEN` | 아니요 | `claude setup-token`에서 받은 OAuth token입니다(global auth의 대안) |
| `CLAUDE_API_KEY` | 아니요 | pay-per-use 방식으로 사용할 Anthropic API key입니다(global auth의 대안) |
| `CODEX_BIN_PATH` | 아니요 | Codex CLI binary의 절대 경로입니다. compiled HarneesLab build에서 auto-detection을 override합니다. |
| `CODEX_ACCESS_TOKEN` | 예(Codex 사용 시) | Codex access token입니다([AI Assistants](/getting-started/ai-assistants/) 참고) |
| `HARNEESLAB_HOME` | 아니요 | HarneesLab-managed file의 base directory입니다. 기본값은 compatibility 때문에 `~/.archon`이며, `ARCHON_HOME` fallback도 유지됩니다. |
| `DATABASE_URL` | 아니요 | PostgreSQL connection string입니다(기본값: SQLite) |
| `LOG_LEVEL` | 아니요 | `debug`, `info`(기본값), `warn`, `error` |
| `PORT` | 아니요 | server port입니다(기본값: 3090, Docker: 3000) |

## 프로젝트 설정

저장소에 `.archon/config.yaml`을 만듭니다.

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'inherit'
    settingSources:
      - project
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium

# docs:
#   path: packages/docs-web/src/content/docs  # Optional: default is docs/
```

전체 옵션과 legacy fallback 규칙은 [설정 레퍼런스](/reference/configuration/)를 참고하세요.
