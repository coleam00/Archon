---
title: 새 개발자 가이드
description: 새 Archon 개발자를 위한 코드베이스 안내 — 아키텍처 개요, workflow, platform, 첫 단계.
category: contributing
audience: [developer]
status: current
sidebar:
  order: 1
---

> **TL;DR**: Archon은 Telegram, Slack, Discord, GitHub를 통해 휴대폰에서 AI coding assistant(Claude Code, Codex)를 제어하게 해 줍니다. AI pair programming용 remote control이라고 보면 됩니다.

---

## 우리가 해결하는 문제

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WITHOUT ARCHON                               │
│                                                                     │
│   You're on the train, phone in hand...                            │
│                                                                     │
│   ┌──────────┐     ❌ Can't SSH      ┌──────────────────┐          │
│   │  Phone   │ ──────────────────────│  Dev Machine     │          │
│   │          │     ❌ No terminal    │  (Claude Code)   │          │
│   └──────────┘     ❌ No IDE         └──────────────────┘          │
│                                                                     │
│   "I wish I could just message Claude to fix that bug..."          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         WITH ARCHON                                 │
│                                                                     │
│   ┌──────────┐                       ┌──────────────────┐          │
│   │  Phone   │ ─────Telegram────────▶│  Archon Server   │          │
│   │          │     "fix issue #42"   │                  │          │
│   └──────────┘                       │  ┌────────────┐  │          │
│        │                             │  │Claude Code │  │          │
│        │                             │  │   SDK      │  │          │
│        │                             │  └─────┬──────┘  │          │
│        │                             │        │         │          │
│        │                             │  ┌─────▼──────┐  │          │
│        │◀────"PR created #127"───────│  │ Git Repo   │  │          │
│        │                             │  │ (worktree) │  │          │
│                                      │  └────────────┘  │          │
│                                      └──────────────────┘          │
│                                                                     │
│   You just fixed a bug from your phone.                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 핵심 개념: Message → AI → Code → Response

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   USER                    ARCHON                         CODEBASE        │
│                                                                          │
│   ┌─────────┐            ┌─────────────────┐            ┌──────────┐    │
│   │Telegram │            │                 │            │          │    │
│   │  Slack  │───Message─▶│   Orchestrator  │───Claude──▶│ Git Repo │    │
│   │ Discord │            │                 │   Code     │          │    │
│   │ GitHub  │◀──Response─│   (routes to    │◀──────────│ (files)  │    │
│   └─────────┘            │    AI client)   │            └──────────┘    │
│                          └─────────────────┘                             │
│                                                                          │
│   That's it. You message, AI works on code, you get results.            │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Archon을 사용하는 네 가지 방식

### 1. Command Line (Local Execution)

Server 없이 terminal에서 workflow를 직접 실행합니다.

```
┌─────────────────────────────────────────────────────────────────┐
│ TERMINAL                                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ $ bun run cli workflow list                                     │
│                                                                 │
│ Available workflows in .archon/workflows/:                     │
│   - archon-assist                General help and questions     │
│   - archon-fix-github-issue      Investigate and fix issues     │
│   - archon-comprehensive-pr-review  Full PR review with agents  │
│                                                                 │
│ $ bun run cli workflow run archon-assist "What does the         │
│   orchestrator do?"                                             │
│                                                                 │
│ 🔧 READ                                                         │
│ Reading: packages/core/src/orchestrator/orchestrator.ts                │
│                                                                 │
│ The orchestrator is the main entry point that routes incoming  │
│ messages. It checks if it's a slash command, loads conversation│
│ context from the database, and routes to the appropriate AI     │
│ client for processing...                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**적합한 용도:** local workflow 실행, testing, automation script, CI/CD

### 2. Direct Chat (간단한 질문)

Claude Code terminal에서처럼 AI와 바로 대화합니다.

```
┌─────────────────────────────────────────────────────────────────┐
│ TELEGRAM CHAT                                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ You: What does the handleMessage function do?                   │
│                                                                 │
│ Archon: Looking at packages/core/src/orchestrator/orchestrator.ts...          │
│                                                                 │
│         The handleMessage function is the main entry point      │
│         that routes incoming messages. It:                      │
│         1. Checks if it's a slash command                       │
│         2. Loads conversation context from database             │
│         3. Routes to AI client for processing                   │
│         4. Streams responses back to platform                   │
│                                                                 │
│         See: packages/core/src/orchestrator/orchestrator.ts            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Slash Commands (특정 작업)

AI를 거치지 않는 deterministic command입니다.

```
┌─────────────────────────────────────────────────────────────────┐
│ SLASH COMMANDS                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ /clone https://github.com/user/repo    Clone a repository      │
│ /status                                 Show current state      │
│ /repos                                  List available repos    │
│ /setcwd /path/to/dir                   Change working dir      │
│ /reset                                  Clear AI session        │
│ /help                                   Show all commands       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4. Workflows (Multi-Step Automation)

Archon이 가장 빛나는 부분입니다. 자동화된 multi-step AI workflow를 실행합니다.

```
┌─────────────────────────────────────────────────────────────────┐
│ GITHUB ISSUE #42                                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Title: Login button doesn't work on mobile                      │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ @user commented:                                                │
│   @archon fix this issue                                        │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ @archon commented:                                              │
│   🔍 Investigation Complete                                     │
│                                                                 │
│   Root Cause: Touch event handler missing on mobile             │
│   File: packages/server/src/components/LoginButton.tsx:45                       │
│   Fix: Add onTouchEnd handler alongside onClick                 │
│                                                                 │
│   Creating PR...                                                │
│                                                                 │
│ ─────────────────────────────────────────────────────────────── │
│                                                                 │
│ @archon commented:                                              │
│   ✅ Fix implemented: PR #127                                   │
│   - Added touch event handling                                  │
│   - Added mobile viewport tests                                 │
│   - All tests passing                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Workflow가 동작하는 방식

Workflow는 AI prompt를 이어 붙이는 YAML file입니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   .archon/workflows/fix-github-issue.yaml                              │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ name: fix-github-issue                                          │  │
│   │ description: Investigate and fix a GitHub issue                 │  │
│   │                                                                 │  │
│   │ nodes:                                                          │  │
│   │   - id: investigate                                             │  │
│   │     command: investigate-issue    ◀── Node 1: Research         │  │
│   │   - id: implement                                               │  │
│   │     command: implement-issue      ◀── Node 2: Fix              │  │
│   │     depends_on: [investigate]                                   │  │
│   │     context: fresh                                              │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│                              │                                          │
│                              ▼                                          │
│                                                                         │
│   EXECUTION FLOW:                                                       │
│                                                                         │
│   ┌──────────────────┐      ┌──────────────────┐      ┌────────────┐  │
│   │  investigate-    │      │   implement-     │      │            │  │
│   │  issue.md        │─────▶│   issue.md       │─────▶│  PR #127   │  │
│   │                  │      │                  │      │            │  │
│   │  - Read issue    │      │  - Read artifact │      │  Created!  │  │
│   │  - Explore code  │      │  - Make changes  │      │            │  │
│   │  - Find root     │      │  - Run tests     │      │            │  │
│   │    cause         │      │  - Commit        │      │            │  │
│   │  - Save artifact │      │  - Create PR     │      │            │  │
│   └──────────────────┘      └──────────────────┘      └────────────┘  │
│                                                                         │
│   Each "command" is a markdown file with AI instructions.              │
│   The workflow executor runs nodes in dependency order.                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Router: Archon이 Workflow를 고르는 방식

메시지를 보내면 AI "router"가 무엇을 할지 결정합니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   USER MESSAGE                           ROUTER DECISION                │
│                                                                         │
│   "fix this issue"          ───────▶     archon-fix-github-issue       │
│   "review this PR"          ───────▶     archon-comprehensive-pr-review│
│   "what does X do?"         ───────▶     archon-assist (catch-all)     │
│   "resolve the conflicts"   ───────▶     archon-resolve-conflicts      │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   HOW IT WORKS:                                                         │
│                                                                         │
│   ┌──────────┐     ┌─────────────────────────────────────┐             │
│   │ Message  │────▶│ Router AI reads workflow descriptions│             │
│   │          │     │ and picks the best match             │             │
│   └──────────┘     └──────────────────┬──────────────────┘             │
│                                       │                                 │
│                                       ▼                                 │
│                    ┌─────────────────────────────────────┐             │
│                    │ /invoke-workflow fix-github-issue   │             │
│                    └─────────────────────────────────────┘             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 사용 가능한 Workflow

아래 표는 주요 bundled workflow를 보여줍니다. 모든 bundled workflow는 `archon-` prefix를 사용합니다. 현재 전체 목록을 보려면 `bun run cli workflow list`를 실행하세요.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   WORKFLOW                              TRIGGER PHRASES    WHAT IT DOES │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ archon-fix-github-issue    "fix this issue"        Investigate   │  │
│   │                            "implement #42"         + Fix + PR    │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ archon-comprehensive-     "review this PR"        5 parallel     │  │
│   │   pr-review               "code review"           review agents  │  │
│   │                                                   + auto-fix     │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ archon-resolve-conflicts  "resolve conflicts"     Auto-resolve   │  │
│   │                           "fix merge conflicts"   git conflicts  │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ archon-ralph-dag          "run ralph"             PRD loop       │  │
│   │                           "ralph dag"             (autonomous)   │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ archon-assist             (anything else)         General help    │  │
│   │                           "what does X do?"       questions,     │  │
│   │                           "help me debug"         debugging      │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Parallel Agents: PR Review 예시

`archon-comprehensive-pr-review` workflow는 5개의 AI agent를 동시에 실행합니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   USER: "review this PR"                                               │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Step 1: pr-review-scope        Determine what changed           │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Step 2: sync-pr-with-main      Rebase onto latest main          │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Step 3: PARALLEL BLOCK (5 agents running at once)               │  │
│   │                                                                 │  │
│   │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │  │
│   │   │ code-review  │  │ error-       │  │ test-        │         │  │
│   │   │ agent        │  │ handling     │  │ coverage     │         │  │
│   │   │              │  │ agent        │  │ agent        │         │  │
│   │   │ Style,       │  │ Catch blocks │  │ Missing      │         │  │
│   │   │ patterns,    │  │ Silent fails │  │ tests?       │         │  │
│   │   │ bugs         │  │ Logging      │  │ Edge cases   │         │  │
│   │   └──────────────┘  └──────────────┘  └──────────────┘         │  │
│   │                                                                 │  │
│   │   ┌──────────────┐  ┌──────────────┐                           │  │
│   │   │ comment-     │  │ docs-        │                           │  │
│   │   │ quality      │  │ impact       │                           │  │
│   │   │ agent        │  │ agent        │                           │  │
│   │   │              │  │              │                           │  │
│   │   │ Outdated?    │  │ README?      │                           │  │
│   │   │ Accurate?    │  │ CLAUDE.md?   │                           │  │
│   │   └──────────────┘  └──────────────┘                           │  │
│   │                                                                 │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Step 4: synthesize-review      Combine all findings             │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Step 5: implement-review-fixes  Auto-fix CRITICAL/HIGH issues   │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Ralph Loop: 자율 PRD 구현

큰 feature에서는 Ralph가 user story를 완료될 때까지 하나씩 실행합니다. Workflow는 `archon-ralph-dag`입니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   PRD FILE: .archon/ralph/my-feature/prd.json                          │
│                                                                         │
│   {                                                                     │
│     "stories": [                                                        │
│       { "id": "S1", "title": "Add button", "passes": true },           │
│       { "id": "S2", "title": "Add handler", "passes": true },          │
│       { "id": "S3", "title": "Add tests", "passes": false }, ◀─ NEXT  │
│       { "id": "S4", "title": "Add docs", "passes": false }             │
│     ]                                                                   │
│   }                                                                     │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   RALPH LOOP EXECUTION:                                                 │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Iteration 1                                                     │  │
│   │ ─────────────────────────────────────────────────────────────── │  │
│   │ 1. Read prd.json → Find S3 (first with passes: false)          │  │
│   │ 2. Implement S3: "Add tests"                                    │  │
│   │ 3. Run: bun run type-check && bun test                         │  │
│   │ 4. Commit: "feat: S3 - Add tests"                              │  │
│   │ 5. Update prd.json: S3.passes = true                           │  │
│   │ 6. More stories remain → Continue                              │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ Iteration 2                                                     │  │
│   │ ─────────────────────────────────────────────────────────────── │  │
│   │ 1. Read prd.json → Find S4 (next with passes: false)           │  │
│   │ 2. Implement S4: "Add docs"                                     │  │
│   │ 3. Run validation                                               │  │
│   │ 4. Commit                                                       │  │
│   │ 5. Update prd.json: S4.passes = true                           │  │
│   │ 6. ALL stories pass → Create PR                                │  │
│   │ 7. Output: <promise>COMPLETE</promise>                          │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│                        LOOP STOPS                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Platform 통합

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   CLI                               HOW IT WORKS                        │
│   ─────────────────────────────────────────────────────────────────    │
│   ┌──────────────────┐              - Direct command execution         │
│   │  Terminal        │              - Real-time streaming to stdout    │
│   │                  │              - No server needed                 │
│   │  bun run cli     │              - Good for local workflows         │
│   │  workflow run    │              - Perfect for CI/CD                │
│   └──────────────────┘                                                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   TELEGRAM                          HOW IT WORKS                        │
│   ─────────────────────────────────────────────────────────────────    │
│   ┌──────────────────┐              - Bot polls for messages           │
│   │  @archon_bot     │              - Real-time streaming (default)    │
│   │                  │              - DM the bot directly              │
│   │  "fix issue #42" │              - Good for mobile use              │
│   └──────────────────┘                                                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   SLACK                             HOW IT WORKS                        │
│   ─────────────────────────────────────────────────────────────────    │
│   ┌──────────────────┐              - Socket Mode (no webhooks)        │
│   │  #dev-channel    │              - @mention in threads              │
│   │                  │              - DM the bot                       │
│   │  @archon review  │              - Good for team visibility         │
│   │  this PR         │                                                  │
│   └──────────────────┘                                                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   DISCORD                           HOW IT WORKS                        │
│   ─────────────────────────────────────────────────────────────────    │
│   ┌──────────────────┐              - WebSocket connection             │
│   │  #coding-help    │              - @mention to activate             │
│   │                  │              - Thread support                   │
│   │  @Archon what    │              - Good for communities             │
│   │  does this do?   │                                                  │
│   └──────────────────┘                                                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   GITHUB                            HOW IT WORKS                        │
│   ─────────────────────────────────────────────────────────────────    │
│   ┌──────────────────┐              - Webhook on issues/PRs            │
│   │  Issue #42       │              - @archon in comments              │
│   │                  │              - Batch mode (single comment)      │
│   │  @archon fix     │              - Auto-creates PRs                 │
│   │  this issue      │              - Good for automation              │
│   └──────────────────┘                                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Isolation: Git Worktrees

각 conversation은 repo의 독립된 copy를 하나씩 받습니다.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   ~/.archon/workspaces/owner/repo/worktrees/                           │
│   │                                                                     │
│   ├── issue-42/              ◀── Conversation about issue #42         │
│   │   └── (full repo)            Working on fix for mobile bug         │
│   │                                                                     │
│   ├── pr-127/                ◀── Conversation about PR #127           │
│   │   └── (full repo)            Reviewing code changes                │
│   │                                                                     │
│   └── task-dark-mode/        ◀── Manual feature work                  │
│       └── (full repo)            Adding dark mode feature              │
│                                                                         │
│   WHY WORKTREES?                                                        │
│   ─────────────────────────────────────────────────────────────────    │
│   - Multiple conversations can work simultaneously                     │
│   - No branch conflicts between parallel work                          │
│   - Each gets isolated file changes                                    │
│   - Cleaned up when issue/PR closes                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Configuration 계층

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   CONFIGURATION LAYERS (later overrides earlier)                       │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ 1. DEFAULTS (hardcoded)                                         │  │
│   │    assistant: claude                                            │  │
│   │    streaming.telegram: stream                                   │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ 2. GLOBAL CONFIG (~/.archon/config.yaml)                        │  │
│   │    botName: MyBot                                               │  │
│   │    defaultAssistant: claude                                     │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ 3. REPO CONFIG (.archon/config.yaml)                            │  │
│   │    assistant: codex          # This repo prefers Codex          │  │
│   │    commands:                                                    │  │
│   │      folder: .claude/commands/custom                            │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│                              ▼                                          │
│   ┌─────────────────────────────────────────────────────────────────┐  │
│   │ 4. ENVIRONMENT VARIABLES (highest priority)                     │  │
│   │    TELEGRAM_STREAMING_MODE=batch                                │  │
│   │    DEFAULT_AI_ASSISTANT=claude                                  │  │
│   └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 디렉터리 구조

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   YOUR REPO                         ARCHON SERVER                       │
│                                                                         │
│   my-app/                           ~/.archon/                          │
│   ├── .archon/                      ├── config.yaml      (global cfg)  │
│   │   ├── config.yaml               ├── workspaces/      (cloned repos)│
│   │   ├── commands/                 │   └── user/repo/                 │
│   │   │   ├── investigate-issue.md  │       ├── source/    (clone)      │
│   │   │   ├── implement-issue.md   │       └── worktrees/ (isolation)  │
│   │   │   └── assist.md            │           ├── issue-42/           │
│   │   ├── workflows/               │           └── pr-127/             │
│   │   │   ├── fix-github-issue.yaml                                    │
│   │   │   └── assist.yaml                                              │
│   │   └── artifacts/                                                   │
│   │       └── issues/                                                  │
│   │           └── issue-42.md                                          │
│   ├── packages/                                                             │
│   └── ...                                                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 빠른 참조: 자주 쓰는 상호작용

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   WHAT YOU WANT                     WHAT TO SAY (Platform/CLI)          │
│                                                                         │
│   Run workflow locally              bun run cli workflow run <name>     │
│   List CLI workflows                bun run cli workflow list           │
│   Fix a GitHub issue                "@archon fix this issue"            │
│   Review a PR                       "@archon review this PR"            │
│   Ask a question                    "What does handleMessage do?"       │
│   Resolve conflicts                 "@archon resolve the conflicts"     │
│   See current state                 "/status"                           │
│   Clone a repo                      "/clone https://github.com/u/r"     │
│   Switch repos                      "/repos" then pick one              │
│   List available workflows          "/workflow list"                    │
│   Reload workflow definitions       "/workflow reload"                  │
│   Approve paused workflow           "/workflow approve <id> [comment]"  │
│   Reject paused workflow           "/workflow reject <id> [reason]"   │
│   Cancel stuck workflow             "/workflow cancel"                  │
│   Start fresh                       "/reset"                            │
│   Get help                          "/help"                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 요약

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   ARCHON = Remote Control for AI Coding Assistants                     │
│                                                                         │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                                                                │   │
│   │   Phone/Slack/GitHub ──▶ Archon Server ──▶ AI (Claude/Codex)  │   │
│   │                              │                    │            │   │
│   │                              ▼                    ▼            │   │
│   │                         Workflows           Git Worktrees      │   │
│   │                        (automation)         (isolation)        │   │
│   │                                                                │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│   KEY CAPABILITIES:                                                    │
│   ─────────────────                                                    │
│   ✓ Message from anywhere (phone, tablet, desktop)                    │
│   ✓ Automated multi-step workflows                                    │
│   ✓ Parallel AI agents for complex tasks                              │
│   ✓ Isolated environments per conversation                            │
│   ✓ Custom prompts versioned in Git                                   │
│   ✓ GitHub integration (issues/PRs/comments)                          │
│                                                                         │
│   WHEN TO USE:                                                         │
│   ─────────────                                                        │
│   ✓ You want to fix bugs from your phone                              │
│   ✓ You want automated PR reviews                                     │
│   ✓ You want GitHub issue automation                                  │
│   ✓ You want parallel development without conflicts                   │
│   ✓ You want custom AI workflows for your team                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 다음 단계

1. **읽기**: [Getting Started](/getting-started/) - 첫 instance 설정
2. **탐색**: `.archon/workflows/` - 예시 workflow 확인
3. **커스터마이즈**: `.archon/commands/` - 직접 prompt 만들기
4. **설정**: `.archon/config.yaml` - 설정 조정

Remote agentic coding에 오신 것을 환영합니다.
