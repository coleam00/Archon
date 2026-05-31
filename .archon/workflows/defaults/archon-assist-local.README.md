# archon-assist-local

A local-only variant of `archon-assist` designed for offline work or environments without GitHub/GitLab access.

## Purpose

Use `archon-assist-local` when you need general assistance but:
- You're working offline
- You don't have GitHub/GitLab CLI authentication configured
- You want to ensure no forge API calls are made
- You're in a restricted network environment

## What It Does

Provides full Claude Code capabilities **except** forge-related operations:

### ✅ Available
- Read and write files
- Run shell commands (except `gh`/`glab`)
- Search the codebase
- Make code changes
- Answer questions
- Git operations (commit, branch, diff, log, etc.)

### ❌ Not Available
- GitHub API calls (`gh` CLI)
- GitLab API calls (`glab` CLI)
- Creating/updating PRs or issues
- Fetching forge metadata
- WebFetch/WebSearch for forge domains

## Usage

Invoke directly or let the router match your request:

```bash
# Via CLI
archon workflow run archon-assist-local "Explain how the database migrations work"

# Via chat platforms (Slack, Telegram, etc.)
/workflow archon-assist-local Refactor the auth module for clarity
```

## When to Use Standard archon-assist Instead

If your task requires:
- Creating or updating pull requests
- Fetching issue details from GitHub/GitLab
- Running `gh` or `glab` commands
- Checking CI status via forge APIs

...use the standard `archon-assist` workflow instead.

## Technical Notes

- Runs in the live checkout (`worktree.enabled: false`)
- Uses the `archon-assist-local` command which includes explicit forge-blocking instructions
- Bundled as a default workflow (no `.archon/workflows/` setup needed)
