---
title: Slack
description: Socket Mode로 Archon을 Slack에 연결합니다. 공개 URL 없이 방화벽 뒤에서도 동작합니다.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 2
---

Archon을 Slack에 연결하면 어떤 Slack workspace에서든 AI 코딩 어시스턴트와 상호작용할 수 있습니다.

## 사전 준비

- 실행 중인 Archon 서버([시작하기](/getting-started/) 참고)
- 앱 설치 권한이 있는 Slack workspace

## 개요

Archon은 Slack 연동에 **Socket Mode**를 사용합니다. 이는 다음을 의미합니다.

- 공개 HTTP endpoint가 필요 없습니다.
- 방화벽 뒤에서도 동작합니다.
- 로컬 개발이 더 단순합니다.
- Slack App Directory용으로는 적합하지 않지만, 개인/팀 사용에는 충분합니다.

## 1단계: Slack App 만들기

1. [Slack API Apps](https://api.slack.com/apps)로 이동합니다.
2. 요청되면 로그인합니다.
3. 앱을 설치할 workspace를 선택합니다.
4. **Create New App**을 클릭합니다.
5. **From scratch**를 선택합니다.
6. 다음을 입력합니다.
   - **App Name**: 원하는 이름(bot을 @mention할 때 사용할 이름)
   - **Workspace**: workspace 선택
7. **Create App**을 클릭합니다.

## 2단계: Socket Mode 활성화

1. 왼쪽 sidebar에서 **Socket Mode**를 클릭합니다.
2. **Enable Socket Mode**를 ON으로 전환합니다.
3. 안내가 나오면 App-Level Token을 만듭니다.
   - **Token Name**: `socket-mode`
   - **Scopes**: `connections:write` 추가
   - **Generate** 클릭
4. **token을 복사합니다**(`xapp-`로 시작). 이것이 `SLACK_APP_TOKEN`입니다.
5. token을 `.env` 파일에 넣습니다.

## 3단계: Bot scope 설정

1. 왼쪽 sidebar에서 **OAuth & Permissions**를 클릭합니다.
2. **Scopes** > **Bot Token Scopes**까지 내려갑니다.
3. bot token scopes에 다음 scope를 추가합니다.
   - `app_mentions:read` -- @mention event 수신
   - `chat:write` -- 메시지 전송
   - `channels:history` -- public channel 메시지 읽기(thread context용)
   - `channels:join` -- bot이 public channel에 참여하도록 허용
   - `groups:history` -- private channel 메시지 읽기(선택)
   - `im:history` -- DM history 읽기(DM 지원용)
   - `im:write` -- DM 전송
   - `im:read` -- DM history 읽기(DM 지원용)
   - `mpim:history` -- group DM history 읽기(선택)
   - `mpim:write` -- group DM 전송

## 4단계: event 구독

1. 왼쪽 sidebar에서 **Event Subscriptions**를 클릭합니다.
2. **Enable Events**를 ON으로 전환합니다.
3. **Subscribe to bot events** 아래에 다음을 추가합니다.
   - `app_mention` -- 누군가 bot을 @mention할 때
   - `message.im` -- bot에게 보내는 direct message
   - `message.channels` -- public channel 메시지(선택, 더 넓은 context용)
   - `message.groups` -- private channel 메시지(선택)
4. **Save Changes**를 클릭합니다.

## 5단계: Workspace에 설치

1. 왼쪽 sidebar에서 **Install App**을 클릭합니다.
2. **Install to Workspace**를 클릭합니다.
3. 권한을 검토하고 **Allow**를 클릭합니다.
4. **Bot User OAuth Token**을 복사합니다(`xoxb-`로 시작). 이것이 `SLACK_BOT_TOKEN`입니다.
5. bot token을 `.env` 파일에 설정합니다.

## 6단계: 환경 변수 설정

`.env` 파일에 추가합니다.

```ini
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

## 7단계: Channel에 bot 초대

1. bot을 사용할 Slack channel로 이동합니다.
2. `/invite @your-bot`을 입력합니다(bot의 display name).
3. 이제 bot이 해당 channel의 @mention에 응답해야 합니다.

## 사용자 allowlist 설정(선택)

bot 접근을 특정 사용자로 제한하려면 다음을 수행합니다.

1. Slack에서 사용자 profile > "..." > "Copy member ID"로 이동합니다.
2. 환경 변수에 추가합니다.

```ini
SLACK_ALLOWED_USER_IDS=U01ABC123,U02DEF456
```

설정하면 나열된 user ID만 bot과 상호작용할 수 있습니다. 비어 있거나 설정하지 않으면 bot은 모든 사용자에게 응답합니다.

## 스트리밍 모드 설정(선택)

```ini
SLACK_STREAMING_MODE=batch  # batch (default) | stream
```

스트리밍 모드의 자세한 내용은 [설정](/getting-started/configuration/)을 참고하세요.

## 사용법

### Channel에서 @mention

```
@your-bot /clone https://github.com/user/repo
```

### Thread에서 작업 이어가기

초기 메시지가 만든 thread에 답장합니다.

```
@your-bot /status
```

### 병렬 작업 시작(Worktree)

```
@your-bot /worktree feature-branch
```

### Direct Messages

bot에게 직접 DM을 보낼 수도 있습니다. @mention은 필요 없습니다.

```
/help
```

## 문제 해결

### bot이 응답하지 않음

1. Socket Mode가 활성화되어 있는지 확인합니다.
2. `.env`의 두 token이 올바른지 확인합니다.
3. app log에서 error를 확인합니다.
4. bot이 channel에 초대되어 있는지 확인합니다.
5. 단순 입력이 아니라 bot을 @mention하고 있는지 확인합니다.

### "channel_not_found" error

bot을 channel에 초대해야 합니다.

```
/invite @your-bot
```

### "missing_scope" error

**OAuth & Permissions**에서 필요한 scope를 추가하고 app을 다시 설치합니다.

### Thread context가 동작하지 않음

다음 scope가 추가되어 있는지 확인합니다.

- `channels:history`(public channels)
- `groups:history`(private channels)

## 보안 권장사항

1. **사용자 allowlist 사용**: `SLACK_ALLOWED_USER_IDS`를 설정해 bot 접근을 제한합니다.
2. **Private Channels**: 필요한 channel에만 bot을 초대합니다.
3. **Token 보안**: token을 version control에 절대 commit하지 않습니다.

## 참고 링크

- [Slack API 문서](https://api.slack.com/docs)
- [Bolt for JavaScript](https://tools.slack.dev/bolt-js/)
- [Socket Mode 가이드](https://api.slack.com/apis/connections/socket)
- [Permission Scopes](https://api.slack.com/scopes)
