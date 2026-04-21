---
title: GitLab
description: 이슈와 merge request에서 AI 코딩 지원을 받을 수 있도록 HarneesLab을 GitLab에 연결합니다.
category: adapters
area: adapters
audience: [operator]
sidebar:
  order: 7
---

:::note
GitLab은 **커뮤니티 어댑터**입니다. 커뮤니티가 기여하고 유지관리합니다.
:::

HarneesLab을 GitLab instance(gitlab.com 또는 self-hosted)에 연결하면 이슈와 merge request에서 AI 코딩 어시스턴트와 상호작용할 수 있습니다.

## 사전 준비

- 실행 중인 HarneesLab 서버([시작하기](/getting-started/overview/) 참고)
- Issues와 merge requests가 활성화된 GitLab project
- `api` scope가 있는 GitLab Personal Access Token 또는 Project Access Token
- Webhook을 받을 공개 endpoint(로컬 개발에서는 아래 ngrok 설정 참고)

## 1단계: GitLab access token 만들기

### Personal Access Token(처음 시작할 때 권장)

1. **GitLab → User Settings → Access Tokens**로 이동합니다.
2. 다음 설정으로 token을 만듭니다.
   - **Name**: `archon`
   - **Scopes**: `api`
   - **Expiration**: 필요에 맞게 설정
3. token을 복사합니다(`glpat-`로 시작).

### Project Access Token(프로덕션 권장)

1. **Project → Settings → Access Tokens**로 이동합니다.
2. 다음 설정으로 token을 만듭니다.
   - **Role**: Developer 또는 Maintainer
   - **Scopes**: `api`
3. 이 방식은 project 범위의 bot user를 만듭니다.

## 2단계: Webhook secret 생성

```bash
openssl rand -hex 32
```

Windows(PowerShell):

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

이 secret을 저장해 둡니다. 3단계와 4단계에서 필요합니다.

## 3단계: 로컬 서버 공개(개발용)

```bash
ngrok http 3090
# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
```

프로덕션에서는 배포된 서버 URL을 직접 사용합니다.

## 4단계: GitLab Webhook 설정

**Project → Settings → Webhooks → Add new webhook**으로 이동합니다.

| 필드 | 값 |
|-------|-------|
| **URL** | `https://your-domain.com/webhooks/gitlab` |
| **Secret token** | 2단계에서 만든 secret |
| **Triggers** | `Comments`, `Issues events`, `Merge request events` 활성화 |
| **SSL verification** | 활성화(권장) |

"Add webhook"을 클릭하고 **Test → Note events**로 검증합니다.

:::note
GitLab은 `X-Gitlab-Token` header에 plain secret token을 사용합니다(GitHub처럼 HMAC이 아닙니다). token은 `GITLAB_WEBHOOK_SECRET`과 정확히 일치해야 합니다.
:::

## 5단계: 환경 변수 설정

```ini
GITLAB_URL=https://gitlab.com
GITLAB_TOKEN=glpat-your-token-here
GITLAB_WEBHOOK_SECRET=your-secret-here
```

Optional:

```ini
GITLAB_ALLOWED_USERS=alice,bob
GITLAB_BOT_MENTION=archon
```

자세한 내용은 [전체 환경 변수 reference](/reference/configuration/)를 참고하세요.

## 사용법

issue 또는 MR 댓글에서 bot을 mention합니다.

```
@harneeslab can you analyze this bug?
@harneeslab /status
@harneeslab review this implementation
```

**첫 mention**은 repository를 `~/.archon/workspaces/<group>/<project>`로 자동 clone하고, `.archon/commands/`가 있으면 감지하며, 전체 issue/MR context를 주입합니다.

**이후 mention**은 전체 context와 함께 기존 conversation을 재개합니다.

## Conversation ID 형식

| 유형 | 형식 | 예시 |
|------|--------|---------|
| Issue | `group/project#iid` | `myteam/api#42` |
| Merge Request | `group/project!iid` | `myteam/api!15` |
| Nested group | `group/subgroup/project#iid` | `org/team/api#7` |

## 지원 event

| GitLab event | 동작 |
|-------------|--------|
| **Note Hook**(@mention이 포함된 comment) | AI conversation 트리거 |
| **Issue Hook**(close) | isolation environment 정리 |
| **MR Hook**(close/merge) | isolation environment 정리 |
| Issue/MR opened | 무시됨(description은 command가 아님) |

## 추가 project 연결

다른 project에도 동일한 webhook을 추가합니다.

```bash
glab api projects/<PROJECT_ID>/hooks \
  --method POST \
  -f url="https://YOUR_DOMAIN/webhooks/gitlab" \
  -f token="YOUR_WEBHOOK_SECRET" \
  -f note_events=true \
  -f issues_events=true \
  -f merge_requests_events=true
```

또는 GitLab UI에서 같은 secret으로 추가합니다.

## 문제 해결

| 문제 | 원인 | 해결 |
|-------|-------|-----|
| `gitlab.invalid_webhook_token` | Secret 불일치 | `GITLAB_WEBHOOK_SECRET`이 webhook config와 정확히 일치하는지 확인 |
| Clone hangs | macOS Keychain credential helper | adapter가 자동으로 비활성화함 |
| `404 Project Not Found` | token 접근 권한 부족 | token에 `api` scope와 project 접근 권한이 있는지 확인 |
| `403 You are not allowed` | 권한 부족 | Developer role 이상 token 사용 |
| webhook delivery 없음 | ngrok URL 변경 | ngrok 재시작 후 webhook URL 업데이트 |
| webhook 자동 비활성화 | 4회 이상 연속 실패 | 문제를 고친 뒤 test event를 보내 재활성화 |

## glab CLI Reference

AI agent는 `glab` CLI command를 사용합니다. 설치하고 인증합니다.

```bash
brew install glab
glab auth login
```

| Command | 용도 |
|---------|---------|
| `glab issue view <IID>` | issue detail 보기 |
| `glab issue note <IID> -m "..."` | issue에 comment 작성 |
| `glab mr view <IID>` | merge request 보기 |
| `glab mr diff <IID>` | MR diff 보기 |
| `glab mr note <IID> -m "..."` | MR에 comment 작성 |
| `glab mr create --title "..." --description "..."` | MR 만들기 |
