---
title: 보안
description: Archon의 보안 모델, 권한, 인가, 데이터 프라이버시를 설명합니다.
category: reference
audience: [user, operator]
sidebar:
  order: 8
---

이 문서는 Archon의 보안 모델을 다룹니다. AI 권한이 어떻게 동작하는지, 플랫폼 접근을 어떻게 제어하는지, webhook을 어떻게 검증하는지, 어떤 데이터가 로그에 남고 남지 않는지를 설명합니다.

## 권한 모델

Archon은 Claude Code SDK를 `bypassPermissions` 모드로 실행합니다. 즉, AI agent는 대화형 확인 프롬프트 없이 파일을 읽고, 쓰고, 실행할 수 있습니다.

**이 모드를 사용하는 이유:**
- Archon은 Slack, Telegram, GitHub 등 터미널 앞의 사람이 매번 승인할 수 없는 플랫폼에서 자동/무인 workflow를 실행하도록 설계되었습니다.
- 대화형 권한 프롬프트가 필요하면 모든 workflow가 멈추고 원격 운영이 불가능해집니다.

**실제로 의미하는 것:**
- AI assistant는 작업 디렉터리(cloned repository 또는 worktree)에 대한 전체 읽기/쓰기 접근 권한을 가집니다.
- shell command 실행, 파일 수정, Claude Code SDK가 제공하는 모든 tool 사용이 가능합니다.
- 작업별 확인 단계는 없습니다.

**완화책:**
- 기본적으로 각 conversation은 격리된 git worktree에서 실행되어 변경 영향 범위를 줄입니다.
- workflow는 node별 tool restriction을 지원해(아래 참고) 각 단계에서 AI가 할 수 있는 일을 제한할 수 있습니다.
- 이 시스템은 단일 개발자 도구로 설계되었습니다. multi-tenant isolation은 제공하지 않습니다.

:::caution
`bypassPermissions`는 전체 파일 및 shell 접근을 부여하므로, AI agent가 repository 내용을 신뢰할 수 있는 환경에서만 Archon을 실행하세요. adapter-level authorization(아래 참고) 없이 신뢰할 수 없는 사용자에게 Archon을 노출하지 마세요.
:::

## Tool 제한

Workflow node는 `allowed_tools`와 `denied_tools`를 지원해 각 단계에서 AI가 사용할 수 있는 tool을 제한합니다. 코드 읽기만 가능한 sandboxed step을 만들거나 특정 tool 사용을 막을 때 유용합니다.

```yaml
nodes:
  - id: review
    prompt: "Review the code for security issues"
    allowed_tools: [Read, Grep, Glob]  # Can only read, not write

  - id: implement
    prompt: "Fix the issues found"
    denied_tools: [WebSearch, WebFetch]  # No internet access
```

**동작 방식:**
- `allowed_tools`는 whitelist입니다. 나열된 tool만 사용할 수 있습니다. 빈 목록(`[]`)은 모든 tool을 비활성화합니다.
- `denied_tools`는 blacklist입니다. 나열된 tool은 차단되고 나머지는 사용할 수 있습니다.
- 두 옵션은 node마다 상호 배타적입니다. 둘 다 설정되면 `allowed_tools`가 우선합니다.
- tool restriction은 현재 Claude provider에서만 지원됩니다. `denied_tools`가 있는 Codex node는 warning을 로그에 남기며, `allowed_tools`는 Codex SDK에서 지원하지 않습니다.

## 데이터 프라이버시와 로깅

Archon은 구조화 로깅(Pino)을 사용하며, 무엇을 기록하고 기록하지 않는지에 대한 명시적 규칙을 둡니다.

**절대 로그에 남기지 않는 것:**
- API key 또는 token(참조가 필요할 때는 앞 8자 + `...` 형태로 mask)
- 사용자 메시지 내용(사용자가 AI에 보낸 텍스트)
- 개인 식별 정보(PII)

**로그에 남기는 것(컨텍스트 포함):**
- Conversation ID, session ID, workflow run ID
- Event name(예: `session.create_started`, `workflow.step_completed`)
- 오류 메시지와 유형(디버깅용)
- 인가되지 않은 접근 시도(masked user ID 포함, 예: `abc***`)

**Log level:**
- 기본값: `info`(운영 이벤트만)
- 자세한 실행 trace가 필요하면 `LOG_LEVEL=debug` 설정
- CLI: `--quiet`(오류만) 또는 `--verbose`(debug)

## Adapter 인가

각 플랫폼 adapter는 환경 변수를 통해 선택적 user whitelist를 지원합니다. whitelist가 설정되면 목록에 있는 사용자만 bot과 상호작용할 수 있습니다. whitelist가 비어 있거나 설정되지 않으면 adapter는 open access mode로 동작합니다.

| Platform | Whitelist Variable | 형식 |
| --- | --- | --- |
| Slack | `SLACK_ALLOWED_USER_IDS` | 쉼표로 구분한 Slack user ID(예: `U01ABC,U02DEF`) |
| Telegram | `TELEGRAM_ALLOWED_USER_IDS` | 쉼표로 구분한 Telegram user ID |
| Discord | `DISCORD_ALLOWED_USER_IDS` | 쉼표로 구분한 Discord user ID |
| GitHub | `GITHUB_ALLOWED_USERS` | 쉼표로 구분한 GitHub username(대소문자 무시) |
| Gitea | `GITEA_ALLOWED_USERS` | 쉼표로 구분한 Gitea username(대소문자 무시) |

**인가 동작:**
- whitelist는 adapter 시작 시 환경 변수에서 한 번 파싱됩니다.
- 모든 incoming message 또는 webhook은 처리 전에 검사됩니다.
- 인가되지 않은 사용자는 조용히 거부됩니다. 오류 응답을 보내지 않습니다.
- 인가되지 않은 시도는 audit을 위해 masked user identifier와 함께 로그에 남습니다.
- Web UI에는 내장 사용자 인증이 없습니다. 공개 노출 시 `CADDY_BASIC_AUTH` 또는 form auth를 사용하세요([Docker / Deployment](/reference/configuration/#docker--deployment) 변수 참고).

## Webhook 보안

GitHub와 Gitea adapter는 webhook signature를 검증해 payload가 설정된 플랫폼에서 왔고 변조되지 않았음을 확인합니다.

**GitHub:**
- `X-Hub-Signature-256` header 사용
- raw request body와 `WEBHOOK_SECRET`으로 HMAC SHA-256 계산
- timing-safe comparison으로 timing attack 방지
- 유효하지 않은 signature는 거부하고 로그에 남김

**Gitea:**
- `X-Gitea-Signature` header 사용(raw hex, `sha256=` prefix 없음)
- 같은 HMAC SHA-256 검증 및 timing-safe comparison 사용
- 유효하지 않은 signature는 거부하고 로그에 남김

**설정:**
1. random secret 생성: `openssl rand -hex 32`
2. 플랫폼 webhook 설정과 HarnessLab 환경에 같은 값을 설정합니다(GitHub는 `WEBHOOK_SECRET`, Gitea는 `GITEA_WEBHOOK_SECRET`).
3. 두 secret은 정확히 일치해야 합니다.

## Secret 처리

**Environment file:**
- 모든 secret(API key, token, webhook secret)은 source control이 아닌 `.env` 파일에 둡니다.
- repository의 `.env.example`에는 placeholder 값만 있습니다. 복사한 뒤 실제 값을 채우세요.
- `.env` 파일을 git에 commit하지 마세요. repository의 `.gitignore`가 이를 제외합니다.

**Subprocess env isolation:**
- 시작 시 `stripCwdEnv()`는 Bun이 CWD `.env` 파일에서 자동 로드한 **모든** key와 nested Claude Code session marker(`CLAUDECODE`, auth var를 제외한 `CLAUDE_CODE_*`), debugger var(`NODE_OPTIONS`, `VSCODE_INSPECTOR_OPTIONS`)를 제거합니다. 이 작업은 어떤 module도 `process.env`를 읽기 전에 실행됩니다.
- 그 다음 `~/.archon/.env`를 신뢰할 수 있는 HarnessLab 설정 source로 로드합니다. 사용자가 이 파일에 설정한 모든 key는 subprocess로 그대로 전달됩니다. allowlist filtering은 없습니다. 이 파일은 사용자가 관리하며 모든 key는 의도적으로 넣은 값입니다.
- `codebase_env_vars` 또는 `.archon/config.yaml`의 `env:`로 설정한 codebase별 env var는 workflow 실행 시점에 위에 병합됩니다.
- CWD `.env` key만 **신뢰하지 않는 source**입니다. 이는 target project에 속하며 Archon에 속하지 않습니다.

### Target repo `.env` 격리

Archon은 구조적 보호를 통해 target repo `.env`가 subprocess로 새는 일을 막습니다.

1. **Boot cleanup:** `stripCwdEnv()`가 application code 실행 전에 Bun이 자동 로드한 CWD `.env` key를 `process.env`에서 제거합니다.
2. **Claude Code subprocess:** `executableArgs: ['--no-env-file']`로 Claude Code subprocess CWD에서 Bun이 `.env`를 자동 로드하지 못하게 합니다.
3. **Bun script node:** `bun --no-env-file`로 script node subprocess가 target repo `.env`를 로드하지 못하게 합니다.
4. **Bash node:** 영향 없음. bash는 `.env` 파일을 자동 로드하지 않습니다.

HarnessLab 자체 env source(`~/.archon/.env`, dev `.env`)는 CWD strip 이후 로드되며 subprocess로 정상 전달됩니다.

**Workflow 실행 중 env var가 필요하면** managed env injection을 사용하세요.
- `.archon/config.yaml`의 `env:` section(repo별, version control 포함)
- Web UI: Settings → Projects → Env Vars(codebase별, HarnessLab DB에 저장)

**CORS:**
- API route는 `WEB_UI_ORIGIN`으로 CORS를 제한합니다. 기본값은 `*`(모두 허용)이며 로컬 단일 개발자 사용에는 적합합니다. 서버를 공개 노출할 때는 특정 origin을 설정하세요.

**Docker 배포:**
- `CLAUDE_USE_GLOBAL_AUTH=true`는 Docker에서 동작하지 않습니다(로컬 `claude` CLI가 없음). `CLAUDE_CODE_OAUTH_TOKEN` 또는 `CLAUDE_API_KEY`를 명시적으로 제공하세요.
- Docker Compose `.env` 파일에서 bcrypt hash의 variable substitution을 막으려면 `$`를 `$$`로 escape하세요.
