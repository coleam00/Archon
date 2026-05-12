---
title: New Developer Guide
description: Codebase orientation for new Archon developers — architecture overview, workflows, platforms, and first steps.
category: contributing
audience: [developer]
status: current
sidebar:
  order: 1
---

> **TL;DR**: Archon lets you control AI coding assistants (Claude Code, Codex) from your phone via Telegram, Slack, Discord, or GitHub. Think of it as a remote control for AI pair programming.

---

## The Problem We Solve

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

## Core Concept: Message → AI → Code → Response

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

## The Four Ways to Use Archon

### 1. Command Line (Local Execution)

Run workflows directly from your terminal without needing the server:

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

**Good for:** Running workflows locally, testing, automation scripts, CI/CD

### 2. Direct Chat (Simple Questions)

Just talk to the AI like you would in Claude Code terminal:

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

### 3. Slash Commands (Specific Operations)

Deterministic commands that don't involve AI:

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

This is where Archon shines - automated multi-step AI workflows:

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

## How Workflows Work (The Magic)

A workflow is a YAML file that chains AI prompts together:

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

## The Router: How Archon Picks Workflows

When you send a message, an AI "router" decides what to do:

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

## Available Workflows

The table below lists the key bundled workflows. All bundled workflows are prefixed with `archon-`. Run `bun run cli workflow list` to see the full current list.

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

## Parallel Agents: The PR Review Example

The `archon-comprehensive-pr-review` workflow runs 5 AI agents simultaneously:

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

## The Ralph Loop: Autonomous PRD Implementation

For larger features, Ralph executes user stories one-by-one until complete. The workflow is `archon-ralph-dag`:

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

## Platform Integration

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

Each conversation gets its own isolated copy of the repo:

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

## Configuration Hierarchy

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

## Directory Structure

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

## Quick Reference: Common Interactions

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

## Summary

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

## Next Steps

1. **Read**: [Getting Started](/getting-started/) - Set up your first instance
2. **Explore**: `.archon/workflows/` - See example workflows
3. **Customize**: `.archon/commands/` - Create your own prompts
4. **Configure**: `.archon/config.yaml` - Tweak settings

Welcome to remote agentic coding!
