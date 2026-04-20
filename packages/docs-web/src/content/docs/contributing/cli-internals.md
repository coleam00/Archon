---
title: CLI 내부 구조
description: HarnessLab CLI 패키지의 기술 reference — entry point 흐름, command routing, worktree logic, adapter 상세.
category: contributing
area: cli
audience: [developer]
status: current
sidebar:
  order: 2
---

CLI 내부 구조를 이해하기 위한 기술 reference입니다.

## 패키지 구조

```
packages/cli/
├── src/
│   ├── cli.ts              # Entry point, argument parsing, routing
│   ├── commands/
│   │   ├── workflow.ts     # workflow list/run (approve/reject/status/resume/abandon delegate to @archon/core/operations)
│   │   ├── isolation.ts    # isolation list/cleanup (list/merged-cleanup delegate to @archon/core/operations)
│   │   ├── setup.ts        # setup command implementation
│   │   ├── chat.ts         # chat command implementation
│   │   ├── validate.ts     # validate command implementation
│   │   └── version.ts      # version command
│   └── adapters/
│       └── cli-adapter.ts  # IPlatformAdapter for stdout
└── package.json            # Defines "archon" binary
```

## Entry Point 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ archon <command> [subcommand] [options] [arguments]             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Load environment                                        │
│         Loads ~/.archon/.env with override: true                │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Parse arguments                                         │
│                 --cwd, --branch, --no-worktree, --help          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Git repository check                                    │
│                 Skip for version/help, validate and resolve to  │
│                 repo root for workflow/isolation commands       │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Route to command handler                                │
│                 switch(command) → workflow | isolation | version│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ cli.ts  Exit with code, always closeDatabase()                  │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/cli.ts`

**Git repository check:**
- `workflow`, `isolation`, `complete` command는 git repository 안에서 실행해야 합니다.
- `version`, `help`, `setup`, `chat` command는 이 check를 우회합니다.
- subdirectory에서 실행하면 repository root로 자동 resolve합니다.
- git repository가 아니면 exit code 1로 종료합니다.

---

## `workflow list` 흐름

```
┌──────────────────────────────────────────────────────────────────┐
│ archon workflow list [--json]                                    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ workflow.ts  workflowListCommand(cwd, json?)                     │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ @archon/workflows/workflow-discovery                              │
│ discoverWorkflowsWithConfig(cwd, config)                          │
│ - Loads bundled defaults                                         │
│ - Searches .archon/workflows/ recursively                        │
│ - Merges (repo overrides defaults by name)                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               │ json=true                     │ json=false
               ▼                               ▼
┌──────────────────────────┐   ┌───────────────────────────────────┐
│ JSON output to stdout    │   │ Human-readable list to stdout     │
│ { workflows, errors }    │   │ name, description, type, options  │
└──────────────────────────┘   └───────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/workflow.ts`

---

## `workflow run` 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ archon workflow run <name> [message] [--branch X] [--from X] [--no-worktree]│
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:78-92  Discover & find workflow by name             │
│                    Error if not found (lists available)         │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:99  Create CLIAdapter for stdout                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:104-133  Database setup                             │
│ - Create conversation: cli-{timestamp}-{random}                 │
│ - Lookup codebase from directory (warn if fails)                │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────┴─────────────┐
                    │                           │
             no --branch                   --branch
                    │                           │
                    ▼                           ▼
┌───────────────────────────┐   ┌───────────────────────────────────┐
│ Use cwd as-is             │   │ workflow.ts:152-168                │
│                           │   │ Auto-detect git repo               │
│                           │   │ Auto-register codebase if needed   │
└─────────────┬─────────────┘   └───────────────┬───────────────────┘
              │                                 │
              │                   ┌─────────────┴─────────────┐
              │                   │                           │
              │            --no-worktree               (default)
              │                   │                           │
              │                   ▼                           ▼
              │   ┌─────────────────────────┐ ┌─────────────────────────┐
              │   │ workflow.ts:171-175     │ │ workflow.ts:177-219     │
              │   │ git.checkout(cwd, branch)│ │ Check existing worktree │
              │   │                         │ │ If healthy → reuse      │
              │   │                         │ │ Else → provider.create()│
              │   │                         │ │ Track in DB             │
              │   └────────────┬────────────┘ └────────────┬────────────┘
              │                │                           │
              └────────────────┴─────────────┬─────────────┘
                                             │
                                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ workflow.ts:235-243  executeWorkflow()                          │
│ - Pass adapter, conversation, workflow, cwd, message            │
│ - Stream AI responses to stdout                                 │
│ - Return success/failure                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/workflow.ts:72-251`

**Worktree Provider:** `packages/isolation/src/providers/worktree.ts`

---

## `workflow event emit` 흐름

```
┌──────────────────────────────────────────────────────────────────┐
│ archon workflow event emit --run-id <uuid> --type <type> [...]   │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ cli.ts  Validate --run-id, --type (required)                     │
│         Validate --type against WORKFLOW_EVENT_TYPES              │
│         Parse --data as JSON (warn + skip if invalid)            │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ workflow.ts  workflowEventEmitCommand(runId, eventType, data?)   │
│              createWorkflowStore().createWorkflowEvent(...)       │
│              Non-throwing (fire-and-forget)                       │
└──────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/cli.ts` (`case 'event'`), `packages/cli/src/commands/workflow.ts:workflowEventEmitCommand`

**Contract:** Event persistence는 best-effort입니다. `createWorkflowEvent`는 내부에서 모든 error를 catch합니다. CLI는 confirmation을 출력하지만, event가 저장됐다고 보장할 수는 없습니다.

---

## `isolation list` 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation list                                           │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:19-57  isolationListCommand()                      │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core isolationDb.listAllActiveWithCodebase()            │
│ - Joins isolation_environments with codebases                   │
│ - Returns: path, branch, workflow_type, codebase_name,          │
│            platform, days_since_activity                        │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:30-55  Group by codebase, print table              │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/isolation.ts:19-57`

---

## `isolation cleanup` 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation cleanup [days]                                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts:62-99  isolationCleanupCommand(daysStale)          │
│                     default: 7 days                             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core isolationDb.findStaleEnvironments(days)            │
│ - WHERE last_activity_at < now - days                           │
│ - Excludes telegram platform                                    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ For each stale environment:                                     │
│ 1. provider.destroy(path, options)                              │
│ 2. Update DB status → 'destroyed'                               │
│ 3. Log result                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/commands/isolation.ts:62-99`

---

## `isolation cleanup --merged` 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│ archon isolation cleanup --merged [--include-closed]            │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isolation.ts  isolationCleanupMergedCommand({ includeClosed })  │
│ For each codebase → cleanupMergedWorktrees(codebaseId, path)    │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                     For each active environment
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ isSafeToRemove() — three-signal union                           │
│  (a) isBranchMerged()    git ancestry (fast-forward/merge)      │
│  (b) isPatchEquivalent() git cherry  (squash-merge)             │
│  (c) getPrState()        gh CLI      (MERGED/CLOSED/OPEN/NONE)  │
│                                                                  │
│  OPEN   → always skip                                           │
│  CLOSED → skip unless includeClosed=true                        │
│  MERGED or any git-signal → proceed to remove                   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ safe=true
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│ Guard checks: no uncommitted changes, no active conversations   │
│ provider.destroy() → remove worktree + delete remote branch     │
└─────────────────────────────────────────────────────────────────┘
```

Signal은 순서대로 평가됩니다. 첫 positive match가 나오면 불필요한 `gh` API call을 피하기 위해 short-circuit합니다. `gh` CLI는 soft dependency입니다. 없거나 실패하면 git signal만 사용하고 결과는 graceful하게 `NONE`으로 degrade됩니다.

**Code:** `packages/core/src/services/cleanup-service.ts` — `isSafeToRemove()`, `cleanupMergedWorktrees()`
**Code:** `packages/isolation/src/pr-state.ts` — `getPrState()`
**Code:** `packages/git/src/branch.ts` — `isPatchEquivalent()`

---

## CLI Adapter

Terminal output용 `IPlatformAdapter`를 구현합니다.

```
┌─────────────────────────────────────────────────────────────────┐
│ CLIAdapter                                                      │
├─────────────────────────────────────────────────────────────────┤
│ sendMessage(convId, msg) → Output to stdout                     │
│ getStreamingMode()       → 'batch'                              │
│ getPlatformType()        → 'cli'                                │
│ ensureThread()           → passthrough                          │
│ start() / stop()         → no-op                                │
└─────────────────────────────────────────────────────────────────┘
```

**Code:** `packages/cli/src/adapters/cli-adapter.ts:13-47`

---

## 주요 Dependency

| Function | Package | Location | Purpose |
|----------|---------|----------|---------|
| `discoverWorkflowsWithConfig(cwd, config)` | `@archon/workflows/workflow-discovery` | `workflows/src/workflow-discovery.ts` | workflow YAML 탐색과 parse |
| `executeWorkflow(...)` | `@archon/workflows/executor` | `workflows/src/executor.ts` | workflow step 실행 |
| `getIsolationProvider()` | `@archon/isolation` | `isolation/src/factory.ts` | WorktreeProvider singleton 가져오기 |
| `conversationDb.*` | `@archon/core` | `core/src/db/conversations.ts` | Conversation CRUD |
| `codebaseDb.*` | `@archon/core` | `core/src/db/codebases.ts` | Codebase CRUD |
| `isolationDb.*` | `@archon/core` | `core/src/db/isolation-environments.ts` | Worktree tracking |
| `git.*` | `@archon/git` | `packages/git/src/` | Git operation |
| `closeDatabase()` | `@archon/core` | `core/src/db/connection.ts` | Clean shutdown |

---

## Conversation ID 형식

CLI conversation은 `cli-{timestamp}-{random}` 형식의 ID를 사용합니다.

예: `cli-1705932847321-a7f3b2`

생성 위치: `packages/cli/src/commands/workflow.ts`

---

## Worktree 재사용 로직

`--branch`가 제공되면:

1. **Lookup:** `isolationDb.findActiveByWorkflow(codebaseId, 'task', branchName)`
2. **Health check:** 기존 항목에 `provider.healthCheck(path)` 실행
3. **Reuse:** 찾았고 healthy하면 재사용합니다. `--from`이 지정됐지만 적용되지 않았으면 warning을 냅니다.
4. **Create:** 없거나 unhealthy하면 생성합니다. `--from`으로 지정된 경우 `fromBranch`를 provider에 전달합니다.

Worktree 저장 위치: `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch-slug>/`

**Code:** `packages/cli/src/commands/workflow.ts:177-219`

---

## Exit Code

| Code | Meaning |
|------|---------|
| 0 | 성공 |
| 1 | Error. git repo 밖에서 실행한 경우를 포함해 stderr에 log됩니다. |

---

## Database Connection

- 첫 database call에서 connection을 엽니다.
- command가 완료된 뒤 `finally` block에서 항상 닫습니다.
- **Default: SQLite**. 위치는 `~/.archon/archon.db`이며, 별도 setup 없이 자동 초기화됩니다.
- **Optional: PostgreSQL**. `DATABASE_URL`이 설정된 경우 사용하며 cloud/advanced deployment용입니다.

**Code:** `packages/cli/src/cli.ts`
