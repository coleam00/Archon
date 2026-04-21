---
title: 플랫폼 어댑터
description: Archon에 연결할 수 있는 모든 플랫폼 어댑터 개요입니다.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 0
---

Archon은 여러 플랫폼 어댑터를 지원합니다. 각 어댑터는 Archon을 서로 다른 커뮤니케이션 채널에 연결해, 사용자가 일하는 곳 어디에서든 워크플로를 실행하고 AI 에이전트와 상호작용할 수 있게 합니다.

## 핵심 어댑터

| 어댑터 | 전송 방식 | 필요한 인증 | 설정 |
|---------|-----------|---------------|-------|
| [**Web UI**](/adapters/web/) | SSE streaming | 없음 | 내장 |
| [**CLI**](/reference/cli/) | stdout | 없음 | 내장 |
| [**Slack**](/adapters/slack/) | Socket Mode | Bot + App tokens | [설정 가이드](/adapters/slack/) |
| [**Telegram**](/adapters/telegram/) | Bot API polling | Bot token | [설정 가이드](/adapters/telegram/) |
| [**GitHub**](/adapters/github/) | Webhooks | Token + webhook secret | [설정 가이드](/adapters/github/) |

## 커뮤니티 어댑터

커뮤니티 어댑터는 동일한 `IPlatformAdapter` 인터페이스를 따르지만, 핵심 지원 범위 밖의 플랫폼을 대상으로 합니다.

| 어댑터 | 전송 방식 | 필요한 인증 | 설정 |
|---------|-----------|---------------|-------|
| [**Discord**](/adapters/community/discord/) | WebSocket | Bot token | [설정 가이드](/adapters/community/discord/) |
| [**Gitea**](/adapters/community/gitea/) | Webhooks | Token + webhook secret | [설정 가이드](/adapters/community/gitea/) |
| [**GitLab**](/adapters/community/gitlab/) | Webhooks | Token + webhook secret | [설정 가이드](/adapters/community/gitlab/) |

## 어댑터 작동 방식

모든 어댑터는 `IPlatformAdapter` 인터페이스를 구현합니다. 어댑터가 담당하는 일은 다음과 같습니다.

- **메시지 수신** -- 플랫폼에서 메시지를 받아 HarneesLab orchestrator로 전달
- **응답 전달** -- AI 응답을 플랫폼으로 다시 스트리밍하거나 배치로 전송
- **권한 제어** -- 접근을 제한하기 위한 선택적 사용자 allowlist
- **대화 추적** -- 플랫폼별 식별자(thread ID, chat ID, issue number)를 HarneesLab 대화에 매핑

## 어댑터 선택

- **Web UI**는 가장 빠르게 시작할 수 있는 방법입니다. 토큰이나 외부 서비스가 필요 없습니다.
- **Slack**과 **Telegram**은 모바일 접근과 팀 협업에 적합합니다.
- **GitHub**는 이슈와 PR 워크플로에 직접 통합됩니다.
- **Discord**는 커뮤니티 또는 팀 서버에 잘 맞습니다.

여러 어댑터를 동시에 실행할 수 있습니다. 필요한 환경 변수가 설정된 어댑터는 서버를 시작할 때 자동으로 함께 시작됩니다.
