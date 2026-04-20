---
title: Gitea
description: 이슈와 PR 자동화를 위해 HarnessLab을 Gitea instance에 연결합니다.
category: adapters
area: adapters
audience: [operator]
sidebar:
  order: 6
---

:::note
Gitea는 **커뮤니티 어댑터**입니다. 커뮤니티가 기여하고 유지관리합니다.
:::

HarnessLab을 self-hosted Gitea instance에 연결하면 Gitea 이슈와 pull request에서 AI 코딩 어시스턴트와 상호작용할 수 있습니다.

## 사전 준비

- 실행 중인 HarnessLab 서버([시작하기](/getting-started/) 참고)
- API access가 활성화된 Gitea instance
- Gitea personal access token 또는 dedicated bot account token
- Webhook을 받을 공개 endpoint(또는 로컬 개발용 tunnel)

## 1단계: Gitea token 만들기

1. Gitea instance에 로그인합니다.
2. **Settings > Applications > Manage Access Tokens**로 이동합니다.
3. repository read/write permission이 있는 새 token을 만듭니다.
4. token을 복사합니다. 3단계에서 필요합니다.

## 2단계: Webhook secret 생성

Linux/Mac:
```bash
openssl rand -hex 32
```

Windows(PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

이 secret을 저장해 둡니다. 3단계와 4단계에서 필요합니다.

## 3단계: 환경 변수 설정

```ini
GITEA_URL=https://gitea.example.com
GITEA_TOKEN=your_personal_access_token
GITEA_WEBHOOK_SECRET=your_secret_from_step_2
```

세 변수는 모두 필수입니다. 세 변수가 모두 설정되면 adapter가 자동으로 시작됩니다.

**선택 변수:**

```ini
# Restrict who can trigger the bot (comma-separated usernames, case-insensitive)
GITEA_ALLOWED_USERS=alice,bob

# Custom @mention name (defaults to BOT_DISPLAY_NAME, then "HarnessLab")
GITEA_BOT_MENTION=archon
```

## 4단계: Gitea Webhook 설정

Gitea에서 repository 설정으로 이동합니다.

- **Settings > Webhooks > Add Webhook > Gitea**로 이동

**Webhook 설정:**

| 필드 | 값 |
|-------|-------|
| **Target URL** | `https://your-domain.com/webhooks/gitea` |
| **HTTP Method** | `POST` |
| **Content Type** | `application/json` |
| **Secret** | 2단계에서 만든 secret 붙여넣기 |
| **Events** | Issues, Issue Comments, Pull Requests, Pull Request Comments |

**Add Webhook**을 클릭하고 **Test Delivery** 버튼으로 연결을 검증합니다.

## 사용법

이슈 또는 PR **댓글**에서 bot을 @mention하여 상호작용합니다.

```
@archon can you analyze this bug?
@archon review this implementation
@archon /workflow run assist "explain the auth flow"
```

**첫 mention 동작:**

- repository를 `~/.archon/workspaces/`로 자동 clone합니다.
- `.archon/commands/`가 있으면 감지하고 로드합니다.
- AI 어시스턴트에 전체 issue/PR context(title, description, labels)를 주입합니다.

**이후 mention:**

- 기존 conversation을 재개합니다.
- 댓글을 넘나들며 전체 context를 유지합니다.

:::note
댓글만 bot을 트리거합니다. 이슈나 PR 설명의 @mention은 무시됩니다. 설명에는 bot 호출 의도가 없는 예제 command나 문서가 들어가는 경우가 많기 때문입니다.
:::

## 작동 방식

Gitea adapter는 GitHub adapter와 비슷한 webhook 기반 forge adapter입니다.

- **Transport**: Gitea에서 HTTP POST webhook을 수신합니다.
- **Signature verification**: `X-Gitea-Signature` header를 사용한 HMAC SHA-256 검증
- **Streaming mode**: 항상 batch(응답당 하나의 일관된 comment, comment spam 방지)
- **Conversation ID format**: issue는 `owner/repo#number`, PR은 `owner/repo!number`
- **Self-loop prevention**: bot comment에는 숨겨진 HTML marker(`<!-- archon-bot-response -->`)가 포함되어 자기 메시지로 다시 트리거되는 것을 방지합니다.
- **Retry logic**: transient network error(timeout, connection reset)는 exponential backoff로 최대 3회 재시도합니다.

### Close/Merge cleanup

이슈가 close되거나 PR이 merge/close되면 adapter가 관련 worktree isolation environment를 자동으로 정리합니다.

## repository 더 추가하기

bot이 감시해야 하는 각 repository에 같은 secret으로 webhook을 추가합니다. 같은 HarnessLab instance를 가리키는 모든 repo의 webhook secret은 동일해야 합니다.

## 더 읽기

- [설정](/reference/configuration/) -- 전체 환경 변수 reference
- [보안](/reference/security/) -- webhook verification과 authorization 세부사항
