---
title: 명령 레퍼런스
description: Web UI, Telegram, Slack, Discord, GitHub 등 HarneesLab adapter에서 사용할 수 있는 slash command 전체 목록입니다.
category: reference
area: handlers
audience: [user]
status: current
sidebar:
  order: 4
---

HarneesLab에서 사용할 수 있는 slash command 전체 목록입니다. Web UI, Telegram, Slack, Discord, GitHub 등 어떤 platform adapter에서든 `/help`를 입력하면 같은 목록을 볼 수 있습니다.

---

## 결정적 명령

이 명령들은 orchestrator가 결정적으로 처리합니다. AI 상태와 관계없이 항상 같은 방식으로 실행됩니다.

## Project 관리

| Command | 설명 |
|---------|-------------|
| `/register-project <path>` | local directory를 HarneesLab project로 등록 |
| `/update-project <name> <path>` | 등록된 project directory path 업데이트 |
| `/remove-project <name>` | project registration 제거 |

## Workflow

| Command | 설명 |
|---------|-------------|
| `/workflow list` | 사용 가능한 workflow 표시 |
| `/workflow reload` | workflow definition 다시 로드 |
| `/workflow status` | 활성 workflow 표시 |
| `/workflow cancel` | 실행 중인 workflow 취소 |
| `/workflow resume <id>` | 실패한 run 재개(다시 실행하되 완료된 node는 skip) |
| `/workflow abandon <id>` | resume하지 않을 run 폐기 |
| `/workflow approve <id> [comment]` | approval gate에서 paused workflow run 승인 |
| `/workflow reject <id> [reason]` | approval gate에서 paused workflow run 거절 |
| `/workflow run <name> [args]` | workflow를 직접 실행 |
| `/workflow cleanup [days]` | CLI 전용 -- 오래된 run record 삭제(기본값: 7일) |

> **참고:** Workflow는 `.archon/workflows/`의 YAML file입니다. `.archon` 경로는 upstream Archon compatibility를 위해 유지됩니다.

## Session 관리

| Command | 설명 |
|---------|-------------|
| `/status` | conversation state 표시 |
| `/reset` | session 완전 초기화 |
| `/help` | 모든 command 표시 |

---

## AI가 라우팅하는 명령

다음 명령들은 command handler에 존재하지만 **결정적으로 라우팅되지 않습니다**. 대신 AI orchestrator를 거치며, context에 따라 호출 여부가 결정됩니다. AI가 메시지를 해당 command로 라우팅하면 동작합니다.

| Command | 설명 |
|---------|-------------|
| `/clone <repo-url>` | repository clone |
| `/repos` | repository 목록 표시(번호 포함) |
| `/repo <#\|name> [pull]` | repo 전환(command auto-load) |
| `/repo-remove <#\|name>` | repo와 codebase record 제거 |
| `/getcwd` | working directory 표시 |
| `/setcwd <path>` | working directory 설정 |
| `/command-set <name> <path> [text]` | file에서 command 등록 |
| `/load-commands <folder>` | command bulk load(recursive) |
| `/commands` | 등록된 command 목록 |
| `/worktree create <branch>` | isolated worktree 생성 |
| `/worktree list` | 이 repo의 worktree 표시 |
| `/worktree remove [--force]` | 현재 worktree 제거 |
| `/worktree cleanup merged\|stale` | worktree 정리 |
| `/worktree orphans` | git에서 확인되는 모든 worktree 표시 |
| `/init` | 현재 repo에 `.archon` 구조 생성 |
| `/reset-context` | worktree는 유지하고 AI context만 reset |

> **참고:** 실제로는 이 명령을 직접 입력할 일이 거의 없습니다. 원하는 일을 자연어로 설명하면 AI router가 적절한 command 또는 workflow를 호출합니다.

---

## Workflow 예시(Telegram)

### 직접 질문하기

```
You: 이 repo 구조를 설명해줘

Bot: [Claude가 분석하고 응답합니다...]
```

### 상태 확인

```
You: /status

Bot: Platform: telegram
     AI Assistant: claude

     Codebase: my-project
     Repository: https://github.com/user/my-project

     Repository: my-project @ main

     Worktrees: 0/10
```

### Session 초기화

```
You: /reset

Bot: Session cleared. Starting fresh on next message.

     Codebase configuration preserved.
```

---

## Workflow 예시(GitHub)

새 issue를 만들거나 기존 issue/PR에 comment를 남깁니다.

```
@your-bot-name authentication flow를 이해할 수 있게 도와줘
```

Bot이 분석으로 응답합니다. 이어서 conversation을 계속할 수 있습니다.

```
@your-bot-name 이 내용을 sequence diagram으로 만들어줘
```

Bot은 context를 유지하고 diagram을 제공합니다.
