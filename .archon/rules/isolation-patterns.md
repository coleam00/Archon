# Isolation Architecture Patterns

## Core Design

- ALL isolation logic is centralized in the orchestrator — adapters are thin
- Every @mention auto-creates a worktree (simplicity > efficiency; worktrees are cheap)
- Data model is work-centric (`isolation_environments` table), enabling cross-platform sharing
- Cleanup is a separate service using git-first checks

## Directory Structure

```
~/.archon/workspaces/owner/repo/
├── source/          # Clone or symlink to local path
├── worktrees/       # Git worktrees for this project
├── artifacts/       # Workflow artifacts (NEVER in git)
│   ├── runs/{id}/   # Per-run artifacts ($ARTIFACTS_DIR)
│   └── uploads/{convId}/  # Web UI file uploads (ephemeral)
└── logs/            # Workflow execution logs
```

## Resolution Flow

1. Adapter provides `IsolationHints` (conversationId, workflowId, branch preference)
2. Orchestrator's `validateAndResolveIsolation()` resolves hints → environment
3. WorktreeProvider creates worktree if needed, syncs with origin first
4. Environment tracked in `isolation_environments` table

## Key Packages

- `@archon/isolation` (`packages/isolation/src/`) — types, providers, resolver, error classifiers
- `@archon/git` (`packages/git/src/`) — branch, worktree, repo operations
- `@archon/paths` (`packages/paths/src/`) — path resolution utilities

## Safety Rules

- NEVER run `git clean -fd` — permanently deletes untracked files
- Use `classifyIsolationError()` to map git errors to user-friendly messages
- Trust git's natural guardrails (refuse to remove worktree with uncommitted changes)
- Use `execFileAsync` (not `exec`) when calling git directly
