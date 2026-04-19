---
description: Prime agent with full Archon codebase understanding
---

# Prime: Load Archon Project Context

## Objective

Build comprehensive understanding of the Archon monorepo before beginning any work. This orients
you on structure, active state, and key architectural conventions.

## Process

### 1. Analyze Project Structure

List the monorepo packages:
!`ls packages/`

Show workspace scripts:
!`cat package.json | head -35`

### 2. Read Core Documentation

Read `CLAUDE.md` in full — it contains the authoritative architecture reference, engineering
principles, import patterns, and development guidelines for this project.

### 3. Identify Key Entry Points

Read these files to understand the primary message and execution flow:

- `packages/core/src/orchestrator/orchestrator-agent.ts` — single entry point for all platforms
- `packages/core/src/handlers/command-handler.ts` — slash command routing (no AI)
- `packages/server/src/index.ts` — server startup, adapter wiring, port allocation
- `packages/workflows/src/executor.ts` — sequential/parallel/loop/DAG workflow execution

### 4. Understand Package Dependency Layers

Read the dependency chain (no @archon/* deps → most isolated):

- `packages/paths/src/index.ts` — path resolution + Pino logger (zero deps)
- `packages/git/src/index.ts` — git ops (depends only on @archon/paths)
- `packages/isolation/src/index.ts` — worktree isolation (depends on @archon/git + @archon/paths)
- `packages/workflows/src/index.ts` — workflow engine (depends on @archon/git + @archon/paths)

### 5. Understand Current State

Check recent commits:
!`git log -10 --oneline`

Check current branch and working tree status:
!`git status`

List any active worktrees:
!`git worktree list`

## Output Report

Provide a concise summary (under 300 words) covering:

### Project Overview
- Archon: Remote agentic coding platform (Slack, Telegram, GitHub, Discord, Web)
- Bun + TypeScript monorepo with 8 packages: paths, git, isolation, workflows, core, adapters, server, web
- SQLite (default, zero-setup) or PostgreSQL (optional via DATABASE_URL)

### Architecture
- Package dependency order and each package's responsibility
- Key interfaces: `IPlatformAdapter`, `IAgentProvider`, `IDatabase`, `IWorkflowStore`
- Message flow: platform adapter → orchestrator-agent → command handler OR AI provider
- Workflow execution: `discoverWorkflows` → router → `executeWorkflow` (steps / loop / DAG)

### Current State
- Active branch, recent changes, any uncommitted work
- Any observations relevant to next task

**Keep it scannable — bullets over prose.**
