---
title: Telegram
description: Bot API를 사용해 Archon을 Telegram에 연결하고 모바일과 데스크톱에서 접근합니다.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 3
---

Archon을 Telegram에 연결하면 어떤 Telegram 클라이언트에서든 AI 코딩 어시스턴트와 상호작용할 수 있습니다.

## 사전 준비

- 실행 중인 Archon 서버([시작하기](/getting-started/) 참고)
- Telegram 계정

## Telegram Bot 만들기

1. Telegram에서 [@BotFather](https://t.me/BotFather)에게 메시지를 보냅니다.
2. `/newbot`을 보내고 안내를 따릅니다.
3. bot token을 복사합니다(형식: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`).

## 환경 변수 설정

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

## 사용자 allowlist 설정(선택)

bot 접근을 특정 사용자로 제한하려면 다음을 수행합니다.

1. Telegram에서 [@userinfobot](https://t.me/userinfobot)에게 메시지를 보내 사용자 ID를 확인합니다.
2. 환경 변수에 추가합니다.

```ini
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

설정하면 나열된 user ID만 bot과 상호작용할 수 있습니다. 비어 있거나 설정하지 않으면 bot은 모든 사용자에게 응답합니다.

## 스트리밍 모드 설정(선택)

```ini
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

스트리밍 모드의 자세한 내용은 [설정](/getting-started/configuration/)을 참고하세요.

## 더 읽기

- [설정](/getting-started/configuration/)
