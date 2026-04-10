# Unified Memory Architecture for Archon

**Date**: 2026-04-10
**Status**: Approved
**Goal**: Eliminate memory fragmentation between CLI (Claude Code terminal) and Archon (Telegram/Slack/Web) by sharing the same 4-layer memory system.

## Problem

Currently 5 separate memory systems exist with no cross-visibility:
- CLI writes to MEMORY.md — Archon can't see it
- Archon writes to `context_summary` in DB — CLI can't see it
- Obsidian session logs partially bridged but inconsistently
- Beads used for both issue tracking and memory (conflated roles)

Result: switching between CLI and Telegram loses context.

## Architecture: 4 Layers

Each layer has a single purpose. Both CLI and Archon read/write the same files.

### Layer 1: CLAUDE.md (HOW to work)
- **Location**: `{project}/CLAUDE.md` (in repo)
- **Purpose**: Instructions, conventions, rules
- **Already shared**: Both read via `settingSources: [project, user]`
- **Changes needed**: None

### Layer 2: MEMORY.md + topic files (WHAT we know)
- **Location**: `~/.claude/projects/{encoded-cwd}/memory/`
- **Purpose**: User profile, feedback, project decisions, persistent knowledge
- **Path encoding**: CWD with `/` replaced by `-`, prefixed with `-`
  - Example: `/Users/anton/Claude workspace/ai-ofm` → `-Users-anton-Claude-workspace-ai-ofm`
  - Full: `~/.claude/projects/-Users-anton-Claude-workspace-ai-ofm/memory/MEMORY.md`
- **CLI**: Auto-loads MEMORY.md index into context (existing behavior)
- **Archon**: Compute path from `conversation.cwd`, auto-inject MEMORY.md index into prompt
- **Writing**: Both can create/update topic files. Agent decides when insights are worth persisting.
- **Changes needed**:
  - Add `computeMemoryPath(cwd)` utility
  - Read MEMORY.md in `buildFullPrompt()` and inject into prompt
  - Remove `context_summary` column usage (keep column for backward compat, stop writing)

### Layer 3: Obsidian Session Logs (WHAT we did)
- **Location**: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Claude/Session-Logs/{project}/`
- **Purpose**: Session timeline, work history, handoff context
- **CLI**: `/compress` writes, `/resume` reads
- **Archon**: `/compact` writes (already implemented), fallback read when MEMORY.md has no relevant context
- **Changes needed**: Keep existing Obsidian save in `/compact`. Remove auto-load from prompt builder (MEMORY.md replaces this).

### Layer 4: Beads (WHAT we're working on)
- **Location**: `{project}/.beads/`
- **Purpose**: Issue tracking, task context, agent task-specific insights
- **CLI**: `bd list`, `bd show`, `bd close`, `bd remember`
- **Archon**: Same commands via Bash (agents working on tasks use beads for issue context)
- **Changes needed**: None — already accessible via Bash when CLAUDE.md mentions it

## Implementation Details

### Path computation

```typescript
function computeMemoryPath(cwd: string): string {
  const encoded = cwd.replace(/\//g, '-');
  const home = process.env.HOME ?? '';
  return `${home}/.claude/projects/${encoded}/memory`;
}
```

### Prompt injection

In `buildFullPrompt()`:
1. If `conversation.cwd` exists → compute memory path
2. If `MEMORY.md` exists at that path → read it (typically 10-50 lines)
3. Inject as `## Project Memory` section in the prompt
4. Agent can read individual topic files via Read tool when needed

### What gets removed

- `context_summary` column: stop writing to it. Keep column in schema (no migration needed).
- `loadLatestSessionLog()` from prompt builder: MEMORY.md replaces this as the primary context source.
- Obsidian auto-read in `buildFullPrompt()`: removed. Obsidian remains write-only from `/compact` and readable by the agent on demand.

### What stays

- `/compact` command: resets session + writes summary to Obsidian. Does NOT write to MEMORY.md (that's the agent's choice during normal work).
- `/resume` command: shows what context is available (MEMORY.md content).
- Auto-compact on expired session: still works — summarizes from message history, resets session. The new session picks up MEMORY.md context automatically.
- Message persistence: still saves user + assistant messages to DB for auto-compact fallback.

## Data flow

```
User message in Telegram
  → orchestrator loads conversation (has cwd)
  → computeMemoryPath(cwd) → read MEMORY.md
  → buildFullPrompt() includes MEMORY.md index
  → agent responds with full project context
  → agent can Read topic files, Obsidian logs, bd show as needed
  → messages saved to DB (for auto-compact fallback)

/compact in Telegram
  → AI summarizes session
  → writes to Obsidian Session-Logs/{project}/
  → resets session
  → next message → loads MEMORY.md again (fresh session, same knowledge)

Agent learns something important
  → agent writes/updates topic file in memory path (Write tool)
  → updates MEMORY.md index
  → knowledge persists for both CLI and Archon
```

## Files to modify

1. `packages/core/src/orchestrator/orchestrator-agent.ts`
   - Add `computeMemoryPath()` utility
   - Update `buildFullPrompt()`: read MEMORY.md, inject as context
   - Remove `loadLatestSessionLog()` from prompt injection (keep function for `/compact` Obsidian write)
   - Remove `context_summary` reads from prompt
   - Update `/resume` to show MEMORY.md content instead of DB summary

2. `packages/core/src/orchestrator/prompt-builder.ts`
   - No changes (prompt structure built in orchestrator-agent.ts)

3. No DB migrations needed (keep `context_summary` column, just stop using it)

## Success criteria

- Open CLI in ai-ofm → agent knows user profile, feedback, project state from MEMORY.md
- Open Telegram ai-ofm topic → agent knows the SAME information
- Work in CLI → `/compress` → switch to Telegram → agent sees session log
- Work in Telegram → agent updates memory topic file → switch to CLI → CLI sees the update
- Beads issues visible to both via `bd` commands
