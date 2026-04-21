---
title: Discord
description: 서버와 DM에서 AI 코딩 지원을 받을 수 있도록 HarneesLab을 Discord에 연결합니다.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 5
---

:::note
Discord는 **커뮤니티 어댑터**입니다. 커뮤니티가 기여하고 유지관리합니다.
:::

HarneesLab을 Discord에 연결하면 어떤 Discord server 또는 DM에서도 AI 코딩 어시스턴트와 상호작용할 수 있습니다.

## 사전 준비

- 실행 중인 HarneesLab 서버([시작하기](/getting-started/) 참고)
- Discord 계정
- bot을 추가하려는 Discord server의 "Manage Server" 권한

## Discord Bot 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications)에 접속합니다.
2. "New Application"을 클릭하고 이름을 입력한 뒤 "Create"를 클릭합니다.
3. 왼쪽 sidebar의 "Bot" tab으로 이동합니다.
4. "Add Bot"을 클릭하고 확인합니다.

## Bot token 가져오기

1. Bot tab에서 "Reset Token"을 클릭합니다.
2. token을 복사합니다(긴 alphanumeric string으로 시작).
3. **안전하게 저장합니다**. 다시 볼 수 없습니다.

## Message Content Intent 활성화(필수)

1. "Privileged Gateway Intents"까지 내려갑니다.
2. **"Message Content Intent"**를 활성화합니다(bot이 메시지를 읽는 데 필요).
3. 변경사항을 저장합니다.

## Server에 bot 초대

1. 왼쪽 sidebar에서 "OAuth2" > "URL Generator"로 이동합니다.
2. "Scopes" 아래에서 다음을 선택합니다.
   - `bot`
3. "Bot Permissions" 아래에서 다음을 선택합니다.
   - Send Messages
   - Read Message History
   - Create Public Threads(선택, thread support용)
   - Send Messages in Threads(선택, thread support용)
4. 아래쪽에 생성된 URL을 복사합니다.
5. 브라우저에 붙여넣고 server를 선택합니다.
6. "Authorize"를 클릭합니다.

**참고:** bot을 추가하려면 "Manage Server" 권한이 필요합니다.

## 환경 변수 설정

```ini
DISCORD_BOT_TOKEN=your_bot_token_here
```

## 사용자 allowlist 설정(선택)

bot 접근을 특정 사용자로 제한하려면 Discord에서 Developer Mode를 활성화합니다.

1. User Settings > Advanced > "Developer Mode" 활성화
2. user를 오른쪽 클릭 > "Copy User ID"
3. 환경 변수에 추가

```ini
DISCORD_ALLOWED_USER_IDS=123456789012345678,987654321098765432
```

## 스트리밍 모드 설정(선택)

```ini
DISCORD_STREAMING_MODE=batch  # batch (default) | stream
```

스트리밍 모드의 자세한 내용은 [설정](/getting-started/configuration/)을 참고하세요.

## 사용법

bot은 다음에 응답합니다.

- **Direct Messages**: 직접 메시지를 보내면 됩니다.
- **Server Channels**: bot을 @mention합니다(예: `@YourBotName help me with this code`).
- **Threads**: bot은 thread conversation에서 context를 유지합니다.

## 더 읽기

- [설정](/getting-started/configuration/)
