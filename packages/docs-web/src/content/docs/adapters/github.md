---
title: GitHub
description: Webhook으로 HarneesLab을 GitHub에 연결해 이슈와 pull request에서 상호작용합니다.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 4
---

HarneesLab을 GitHub에 연결하면 이슈와 pull request에서 AI 코딩 어시스턴트와 상호작용할 수 있습니다.

## 사전 준비

- 실행 중인 HarneesLab 서버([시작하기](/getting-started/) 참고)
- Issues가 활성화된 GitHub repository
- 환경 변수에 설정된 `GITHUB_TOKEN`([시작하기](/getting-started/) 참고)
- Webhook을 받을 공개 endpoint(로컬 개발에서는 아래 ngrok 설정 참고)

## 1단계: Webhook secret 생성

Linux/Mac:
```bash
openssl rand -hex 32
```

Windows(PowerShell):
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

이 secret을 저장해 둡니다. 3단계와 4단계에서 필요합니다.

## 2단계: 로컬 서버 공개(개발용)

### ngrok 사용(무료 티어)

```bash
# Install ngrok: https://ngrok.com/download
# Or: choco install ngrok (Windows)
# Or: brew install ngrok (Mac)

# Start tunnel
ngrok http 3090

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
# Free tier URLs change on restart
```

테스트하는 동안 이 터미널을 열어 둡니다.

### Cloudflare Tunnel 사용(고정 URL)

```bash
# Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
cloudflared tunnel --url http://localhost:3090

# Get persistent URL from Cloudflare dashboard
```

고정 URL은 재시작해도 유지됩니다.

**프로덕션 배포**에서는 배포된 서버 URL을 사용합니다. 터널은 필요하지 않습니다.

## 3단계: GitHub Webhook 설정

Repository 설정으로 이동합니다.

- 이동 경로: `https://github.com/owner/repo/settings/hooks`
- "Add webhook"을 클릭합니다.
- **참고**: 여러 repository를 연결하려면 각 repository에 webhook을 개별적으로 추가해야 합니다.

**Webhook 설정:**

| 필드 | 값 |
|-------|-------|
| **Payload URL** | 로컬: `https://abc123.ngrok-free.app/webhooks/github`<br>프로덕션: `https://your-domain.com/webhooks/github` |
| **Content type** | `application/json` |
| **Secret** | 1단계에서 만든 secret 붙여넣기 |
| **SSL verification** | SSL verification 활성화(권장) |
| **Events** | "Let me select individual events" 선택:<br>- Issues<br>- Issue comments<br>- Pull requests |

"Add webhook"을 클릭하고, delivery 이후 초록색 체크 표시가 나타나는지 확인합니다.

## 4단계: 환경 변수 설정

```ini
WEBHOOK_SECRET=your_secret_from_step_1
```

**중요**: `WEBHOOK_SECRET`은 GitHub webhook 설정에 입력한 값과 정확히 일치해야 합니다.

## 5단계: 스트리밍 설정(선택)

GitHub adapter는 항상 `batch` 모드를 사용합니다(하드코딩). GitHub issues와 PR에서는 스트리밍 업데이트보다 완성된 단일 댓글이 더 적합하기 때문입니다.

## 사용법

이슈 또는 PR **댓글**에서 bot을 @mention하여 상호작용합니다.

```
@harneeslab can you analyze this bug?
@harneeslab prime the codebase
@harneeslab review this implementation
```

**첫 mention 동작:**

- Repository를 `~/.archon/workspaces/`로 자동 clone합니다.
- `.archon/commands/`가 있으면 감지하고 로드합니다.
- AI 어시스턴트에 전체 issue/PR context를 주입합니다.

**이후 mention:**

- 기존 대화를 이어서 재개합니다.
- 댓글을 넘나들며 전체 context를 유지합니다.

:::note
댓글만 bot을 트리거합니다. 이슈나 PR 설명의 @mention은 무시됩니다. 설명에는 bot 호출 의도가 없는 예제 명령이나 문서가 들어가는 경우가 많기 때문입니다.
:::

## 추가 repository 연결

서버가 실행 중이면 같은 secret으로 webhook을 만들어 repository를 더 추가할 수 있습니다.

**GitHub UI 사용:** Repo Settings > Webhooks > Add webhook

- **Payload URL**: 서버 URL + `/webhooks/github`
- **Content type**: `application/json`
- **Secret**: `.env`의 동일한 `WEBHOOK_SECRET`
- **Events**: Issues, Issue comments, Pull requests

**CLI 사용:**

```bash
# Get your existing webhook secret
WEBHOOK_SECRET=$(grep WEBHOOK_SECRET .env | cut -d= -f2)

# Add webhook to new repo (replace OWNER/REPO)
gh api repos/OWNER/REPO/hooks --method POST \
  -f "config[url]=https://YOUR_DOMAIN/webhooks/github" \
  -f "config[content_type]=json" \
  -f "config[secret]=$WEBHOOK_SECRET" \
  -f "events[]=issues" \
  -f "events[]=issue_comment" \
  -f "events[]=pull_request"
```

**중요**: 모든 repository에서 webhook secret은 동일해야 합니다.

## 더 읽기

- [설정](/getting-started/configuration/)
