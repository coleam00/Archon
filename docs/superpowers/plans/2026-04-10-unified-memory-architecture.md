# Unified Memory Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Archon agents access to the same MEMORY.md + topic files that CLI uses, eliminating memory fragmentation.

**Architecture:** Add `computeMemoryPath(cwd)` to derive the CLI memory directory from the conversation's working directory. Inject MEMORY.md index into every prompt. Remove `context_summary` DB reads and Obsidian auto-load from prompt builder — MEMORY.md replaces both.

**Tech Stack:** TypeScript, Node.js fs/promises, existing orchestrator-agent.ts

---

### Task 1: Add `computeMemoryPath()` and `loadMemoryIndex()`

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator-agent.ts` (Shared Memory section, ~line 1371)

- [ ] **Step 1: Add `computeMemoryPath` function after the existing `VAULT_SESSION_LOGS` constant**

```typescript
// ─── Project Memory (MEMORY.md — shared with CLI) ──────────────────────────

/**
 * Compute the path to Claude Code's per-project memory directory.
 * CLI encodes the CWD by replacing '/' with '-' as the project folder name.
 * Example: /Users/anton/Claude workspace/ai-ofm
 *   → ~/.claude/projects/-Users-anton-Claude-workspace-ai-ofm/memory/
 */
function computeMemoryPath(cwd: string): string {
  const encoded = cwd.replace(/\//g, '-');
  const home = process.env.HOME ?? '';
  return join(home, '.claude', 'projects', encoded, 'memory');
}

/**
 * Load MEMORY.md index from the CLI memory directory for a project.
 * Returns the file content (typically 10-50 lines) or null if not found.
 * This is the same file Claude Code CLI auto-loads — sharing it gives
 * Archon agents identical project knowledge.
 */
async function loadMemoryIndex(cwd: string): Promise<string | null> {
  try {
    const memoryDir = computeMemoryPath(cwd);
    const indexPath = join(memoryDir, 'MEMORY.md');
    if (!existsSync(indexPath)) return null;

    const content = await readFile(indexPath, 'utf-8');
    if (!content.trim()) return null;

    getLog().debug({ cwd, memoryDir }, 'memory.index_loaded');
    return content.trim();
  } catch (error) {
    getLog().warn({ err: error as Error, cwd }, 'memory.index_load_failed');
    return null;
  }
}
```

- [ ] **Step 2: Verify imports exist at the top of the file**

Confirm these imports are present (they were added in a previous commit):
```typescript
import { writeFile, readFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
```

If `readFile` is missing from the import, add it.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/orchestrator/orchestrator-agent.ts
git commit -m "feat: add computeMemoryPath and loadMemoryIndex utilities

Computes the Claude Code CLI memory directory path from a project's
CWD and loads the MEMORY.md index for prompt injection."
```

---

### Task 2: Replace `context_summary` / Obsidian auto-load with MEMORY.md in `buildFullPrompt()`

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator-agent.ts` (`buildFullPrompt()` function, ~line 450-505)

- [ ] **Step 1: Replace the context loading block in `buildFullPrompt()`**

Find this block (approximately lines 467-483):
```typescript
  // Load context: prefer DB summary, fall back to latest Obsidian session log
  let contextContent = conversation.context_summary;
  if (!contextContent && conversation.codebase_id) {
    const codebase = codebases.find(c => c.id === conversation.codebase_id);
    if (codebase) {
      contextContent = await loadLatestSessionLog(getProjectSlug(codebase));
    }
  }

  const summarySuffix = contextContent
    ? '\n\n---\n\n## Previous Session Context\n\nThe following is context from a prior session (shared across CLI and Telegram). Use it to maintain continuity.\nFor more history, check Obsidian vault at `Claude/Session-Logs/` using Obsidian MCP tools.\n\n' +
      contextContent
    : '';
```

Replace with:
```typescript
  // Load project memory (MEMORY.md) — shared with CLI Claude Code
  let memoryContent: string | null = null;
  if (conversation.cwd) {
    memoryContent = await loadMemoryIndex(conversation.cwd);
  }

  const memorySuffix = memoryContent
    ? '\n\n---\n\n## Project Memory\n\nLoaded from MEMORY.md (shared with CLI). Topic files can be read on demand via the Read tool at: `' +
      computeMemoryPath(conversation.cwd ?? '') + '/`\n' +
      'For session history, check Obsidian vault at `Claude/Session-Logs/` via Obsidian MCP or filesystem.\n\n' +
      memoryContent
    : '';
```

- [ ] **Step 2: Update both return statements to use `memorySuffix` instead of `summarySuffix`**

Replace the two returns (thread context and non-thread):
```typescript
  if (threadContext) {
    return (
      systemPrompt +
      memorySuffix +
      '\n\n---\n\n## Thread Context (previous messages)\n\n' +
      threadContext +
      '\n\n---\n\n## Current Request\n\n' +
      message +
      contextSuffix +
      fileSuffix
    );
  }

  return systemPrompt + memorySuffix + '\n\n---\n\n## User Message\n\n' + message + contextSuffix + fileSuffix;
```

- [ ] **Step 3: Run type-check**

```bash
bun run type-check
```
Expected: all packages exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/orchestrator/orchestrator-agent.ts
git commit -m "feat: inject MEMORY.md into prompt instead of context_summary

Replaces DB context_summary and Obsidian auto-load with MEMORY.md
index — the same file CLI uses. Both interfaces now share one
source of project knowledge."
```

---

### Task 3: Update `/resume` to show MEMORY.md content

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator-agent.ts` (`handleResume()` function, ~line 1585)

- [ ] **Step 1: Replace the `handleResume` function**

Find:
```typescript
async function handleResume(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation
): Promise<void> {
  if (!conversation.context_summary) {
    await platform.sendMessage(
      conversationId,
      'No saved context. Use `/compact` first to save a conversation summary.'
    );
    return;
  }

  const preview =
    conversation.context_summary.length > 500
      ? conversation.context_summary.slice(0, 500) + '...'
      : conversation.context_summary;

  await platform.sendMessage(
    conversationId,
    `**Saved context** (${String(conversation.context_summary.length)} chars):\n\n${preview}\n\n_This context is automatically loaded into every new message._`
  );
}
```

Replace with:
```typescript
async function handleResume(
  platform: IPlatformAdapter,
  conversationId: string,
  conversation: Conversation
): Promise<void> {
  // Show MEMORY.md content (shared with CLI)
  const memoryContent = conversation.cwd ? await loadMemoryIndex(conversation.cwd) : null;

  if (!memoryContent) {
    await platform.sendMessage(
      conversationId,
      'No project memory found. Memory is shared with CLI — work in either interface to build it up.'
    );
    return;
  }

  const preview = memoryContent.length > 1000
    ? memoryContent.slice(0, 1000) + '\n...(truncated)'
    : memoryContent;

  const memoryPath = computeMemoryPath(conversation.cwd ?? '');
  await platform.sendMessage(
    conversationId,
    `**Project Memory** (${String(memoryContent.length)} chars, shared with CLI):\n\n${preview}\n\nPath: \`${memoryPath}/\``
  );
}
```

- [ ] **Step 2: Run type-check**

```bash
bun run type-check
```
Expected: all packages exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/orchestrator/orchestrator-agent.ts
git commit -m "feat: /resume shows MEMORY.md content instead of DB summary

Shows the shared project memory that both CLI and Archon use,
with path to the memory directory for transparency."
```

---

### Task 4: Stop writing `context_summary` to DB in auto-compact

**Files:**
- Modify: `packages/core/src/orchestrator/orchestrator-agent.ts` (auto-compact catch block, ~line 845 and handleCompact, ~line 1530)

- [ ] **Step 1: Remove `context_summary` write from auto-compact catch block**

Find in the catch block (~line 862):
```typescript
          if (summary.trim()) {
            await db.updateConversationSummary(conversation.id, summary.trim());
          }
```

Replace with:
```typescript
          // Summary is written to Obsidian by /compact, not to DB.
          // Auto-compact only resets the session — MEMORY.md provides context for the next session.
```

- [ ] **Step 2: Remove `context_summary` write from `handleCompact`**

Find in `handleCompact` (~line 1540):
```typescript
  await db.updateConversationSummary(conversation.id, trimmedSummary);
```

Remove this line. The `/compact` already saves to Obsidian — no need for DB cache.

- [ ] **Step 3: Run type-check**

```bash
bun run type-check
```
Expected: all packages exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/orchestrator/orchestrator-agent.ts
git commit -m "refactor: stop writing context_summary to DB

MEMORY.md is now the primary context source. Obsidian session logs
remain as supplementary history. DB context_summary column kept
for backward compatibility but no longer written."
```

---

### Task 5: Update `/help` text and orchestrator rules doc

**Files:**
- Modify: `packages/core/src/handlers/command-handler.ts` (help text)
- Modify: `.claude/rules/orchestrator.md`

- [ ] **Step 1: Update `/resume` description in help text**

In `command-handler.ts`, find:
```typescript
- \`/resume\` — Show saved context summary
```

Replace with:
```typescript
- \`/resume\` — Show project memory (shared with CLI)
```

- [ ] **Step 2: Update orchestrator.md `/resume` description**

In `.claude/rules/orchestrator.md`, find the table row for `/resume`:
```
| `/resume` | Handled inline — shows stored context summary |
```

Replace with:
```
| `/resume` | Handled inline — shows MEMORY.md content (shared with CLI) |
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/handlers/command-handler.ts .claude/rules/orchestrator.md
git commit -m "docs: update /resume description to reflect shared memory"
```

---

### Task 6: Verify end-to-end + push

- [ ] **Step 1: Run full validation**

```bash
bun run validate
```
Expected: type-check, lint, format, tests all pass.

- [ ] **Step 2: Manual verification**

Check that `computeMemoryPath` produces correct paths:
```bash
# In node/bun REPL:
const cwd = '/Users/anton/Claude workspace/ai-ofm';
const encoded = cwd.replace(/\//g, '-');
console.log(`${process.env.HOME}/.claude/projects/${encoded}/memory`);
# Expected: /Users/anton/.claude/projects/-Users-anton-Claude-workspace-ai-ofm/memory
```

Verify MEMORY.md exists at that path:
```bash
ls ~/.claude/projects/-Users-anton-Claude-workspace-ai-ofm/memory/MEMORY.md
```

- [ ] **Step 3: Push all changes**

```bash
git push
```

- [ ] **Step 4: Restart server and test in Telegram**

```bash
pkill -f "bun.*watch.*index.ts"; sleep 1
cd packages/server && bun --watch src/index.ts &>/tmp/archon-dev.log &
```

Send a message in the ai-ofm Telegram topic. Check logs for `memory.index_loaded`.
Send `/resume` — should show MEMORY.md content.
