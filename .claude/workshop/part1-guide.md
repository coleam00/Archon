# Claude Code Latest Features Workshop Guide

**Host**: Thomas | **Date**: March 7, 2026
**Duration**: ~35 minutes + Q&A
**Required**: Claude Code v2.1.63+, Max plan, tmux, GitHub CLI (`gh`)

---

## Pre-Workshop Setup

Run these commands BEFORE going live:

```bash
# Verify version
claude --version
# If below 2.1.63:
claude update

# Enable Agent Teams (add to ~/.claude/settings.json)
cat ~/.claude/settings.json
```

Your `~/.claude/settings.json` should contain:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

```bash
# Verify tmux is installed
tmux -V

# Verify GitHub CLI
gh auth status

# Hide email/org in UI for streaming
export IS_DEMO=1

# Prepare a demo project (medium-sized TypeScript/React project with tests)
cd ~/demo-project
git status
```

---

## Feature 1: Agent Teams (10 min)

### What It Is

Multiple Claude Code instances working as a coordinated team. One session is the **team lead**, others are **teammates**. Unlike subagents, teammates can **message each other directly**, share findings mid-task, and coordinate through a **shared task list**.

### Agent Teams vs Subagents

| | Subagents | Agent Teams |
|---|---|---|
| Communication | Report results to main agent only | Teammates message each other directly |
| Coordination | Main agent relays everything | Shared task list with self-claiming |
| Context | Results summarized back | Each teammate has full independent context |
| Best for | Focused tasks | Complex work requiring discussion |

### Live Demo

#### Step 1: Start Claude in tmux

```bash
tmux new-session -s workshop
claude
```

#### Step 2: Give a multi-faceted task

Copy-paste this prompt:

```
Create an agent team with 3 teammates to review this codebase:
- Teammate 1: Security review (auth, input validation, secrets)
- Teammate 2: Performance review (queries, loops, caching)
- Teammate 3: Test coverage (missing tests, edge cases)
Use split pane display mode.
```

#### Step 3: Show the audience

- **Split panes**: each teammate has its own pane, working independently
- **Teammate messaging**: teammates discover findings and share with each other (not just the lead)
- **Task list**: press `Ctrl+T` to toggle the shared task list view

#### Step 4: Navigate teammates

| Key | Action |
|-----|--------|
| `Shift+Down` | Cycle to next teammate |
| `Shift+Up` | Cycle to previous teammate |
| `Ctrl+T` | Toggle task list view |
| `Enter` | View teammate's session |
| `Escape` | Interrupt a teammate's current turn |
| `Shift+Tab` | Toggle delegate mode (lead = coordination only) |

#### Step 5: Show delegate mode

```
Press Shift+Tab to toggle delegate mode.
```

> **Explain**: "In delegate mode, the lead ONLY coordinates and never starts coding itself. This prevents the lead from doing work that should be parallelized across teammates."

### Key Talking Points

- "The biggest paradigm shift: Claude Code went from 'smart terminal assistant' to 'multi-agent orchestration platform.'"
- "Start with 3-5 teammates and 5-6 tasks per teammate for best results."
- "Nicholas Carlini ran 16 agents simultaneously -- 2,000 sessions, $20k in API costs -- built a 100k-line Rust C compiler that compiles the Linux kernel on x86, ARM, and RISC-V. Passes 99% of GCC torture tests."

### Gotchas

- No session resumption for teammates (they start fresh each time)
- One team per session, no nested teams
- Token costs are 2-4x a single session
- tmux required for split pane mode (VS Code terminal not supported)

---

## Feature 2: Native Git Worktrees (5 min)

### What It Is

Each Claude Code session or subagent gets a **completely isolated copy** of your codebase via git worktrees. No file conflicts between parallel agents. This is the infrastructure that makes Agent Teams and `/batch` safe.

### Three Levels of Integration

**Level 1 -- CLI sessions:**

```bash
# Named worktree
claude --worktree feature-auth

# Auto-generated name
claude --worktree

# Combined with tmux
claude --worktree feature-auth --tmux
```

**Level 2 -- Subagent isolation (in custom agent frontmatter):**

```yaml
---
name: refactor-agent
description: Handles large-scale refactoring in isolation
isolation: worktree
---
```

**Level 3 -- Desktop app:** automatic isolation for every new session by default.

### Live Demo

#### Step 1: Show current state

```bash
git branch
git worktree list
ls .claude/worktrees/ 2>/dev/null || echo "No worktrees yet"
```

#### Step 2: Create a worktree session

```bash
claude --worktree demo-feature
```

#### Step 3: Show what happened (in another terminal)

```bash
git worktree list
ls .claude/worktrees/
```

#### Step 4: Make a change inside the worktree session

```
Add a hello world endpoint to src/api/hello.ts
```

#### Step 5: Prove isolation

Switch to original terminal:

```bash
# This file doesn't exist in the main working tree!
cat src/api/hello.ts
```

#### Step 6: Exit and show cleanup

Exit the worktree Claude session. Then:

```bash
git worktree list
# Worktree is gone (auto-cleaned if no changes kept)
```

### Cleanup Behavior

| Scenario | Result |
|----------|--------|
| No changes made | Worktree + branch auto-removed |
| Changes or commits exist | Claude prompts: keep or remove |
| Keep | Preserves directory + branch for review |
| Remove | Deletes everything including uncommitted changes |

### Key Talking Point

> "Without worktrees, parallel agents are limited to reading files or writing to non-overlapping paths -- fragile. With worktrees, Agent A can rewrite `src/auth.ts` while Agent B rewrites the same file. You review both branches and pick the winner."

---

## Feature 3: `/batch` -- Parallel Codebase-Wide Changes (8 min)

### What It Is

One command that decomposes a large change into 5-30 independent units, spawns one agent per unit (each in its own worktree), and opens a PR for each. Every PR is already reviewed by `/simplify`.

### Three-Phase Flow

```
Phase 1: RESEARCH & PLAN (waits for YOUR approval)
  -> Explores codebase, identifies affected files
  -> Decomposes into 5-30 independent units
  -> Shows you the plan -- NOTHING happens until you approve

Phase 2: PARALLEL EXECUTION (after approval)
  -> One agent per unit, each in isolated worktree
  -> Each agent: implement -> /simplify -> test -> commit -> PR

Phase 3: PROGRESS TRACKING
  -> Real-time status table
  -> Final summary: "22/24 units landed as PRs"
```

### Live Demo

#### Step 1: Show the problem

```bash
# Show a pattern you want to fix across many files
grep -r "console.log" src/ --include="*.ts" | head -20
```

#### Step 2: Run `/batch`

Inside Claude Code:

```
/batch replace all console.log calls with the structured logger from src/utils/logger.ts
```

#### Step 3: Review the decomposition plan

- Show the audience the unit breakdown
- Explain: "This is the approval gate -- nothing runs until I say yes"

#### Step 4: Approve

Type `yes` or `approve`.

#### Step 5: Watch parallel execution

- Show the real-time status table updating
- Point out: each worker creates its own worktree

#### Step 6: Show the PRs

```bash
gh pr list
```

### Example Commands to Copy-Paste

```
/batch migrate all Jest tests to Vitest
/batch convert all CommonJS require() to ES import
/batch add type annotations to all untyped function parameters
/batch replace all uses of lodash with native equivalents
/batch standardize all API error responses to use { error: string, code: number }
/batch update all API endpoints to use the new auth middleware
```

### Key Talking Points

- "A week-long migration becomes a parallelized, reviewable process."
- "Each PR is independently reviewable and mergeable -- no 500-file mega-PRs."
- "Every PR already went through /simplify's three-agent code review."

### Gotchas

1. **Git required** -- won't run without a git repo
2. **Units must be truly independent** -- if Agent A creates a utility that Agent B needs to import, it breaks. Create shared dependencies first, then batch the rest.
3. **Be specific** -- "improve code quality" produces poor decomposition; "replace lodash.get with optional chaining" works great
4. **Existing tests recommended** -- workers run tests to verify their changes

---

## Feature 4: Remote Control (5 min)

### What It Is

Continue your Claude Code session from your phone, tablet, or any browser. Your code **never leaves your machine** -- only chat messages flow through an encrypted bridge.

### Remote Control vs Claude Code on the Web

| | Remote Control | Claude Code on the Web |
|---|---|---|
| Where code runs | **Your local machine** | Anthropic cloud VM |
| Filesystem | Full local access | Cloned repo only |
| MCP servers | All your local MCPs | Not available |
| Session persistence | Dies if terminal closes | Persists through shutdown |
| GitHub required | No | Yes (GitHub only) |
| Best for | Mid-task steering, local env | Fire-and-forget cloud work |

### Architecture (show this diagram)

```
Your Laptop (Terminal)          Anthropic API             Phone/Browser
  [Claude Code] ----HTTPS----> [Message Relay] <----HTTPS---- [claude.ai]
       |                             |
  Local filesystem              Only chat messages
  MCP servers                   & tool results flow
  .claude/ config               through the bridge
  Full tool access
```

### Live Demo

#### Step 1: Start a Claude Code session

```bash
cd ~/demo-project
claude
```

#### Step 2: Start working on something

```
Fix the authentication middleware in src/auth.ts
```

Let Claude start working...

#### Step 3: Enable Remote Control

```
/rc
```

A QR code appears.

#### Step 4: Connect from phone

- Scan the QR code with the Claude mobile app
- Show the audience: session appears on phone
- Type a message from the phone -- show it appearing in terminal
- Approve a file change from phone

#### Step 5: Return to terminal

Everything is exactly where you left it. Same session, same context.

### All Entry Points

| Method | Command |
|--------|---------|
| New session from CLI | `claude remote-control` or `claude rc` |
| Inside existing session | `/remote-control` or `/rc` |
| Auto-enable for all sessions | `/config` -> toggle "Enable Remote Control" |
| On phone | Scan QR code or find session by name on claude.ai |

### Pro Tips

```
# Name your session before going remote (easier to find on phone)
/rename "auth-refactor"

# Then enable remote control
/rc
```

### Gotchas

1. **Terminal must stay open** -- closing the terminal kills the session
2. **Max plan required** (Pro coming soon)
3. **10-minute network timeout** -- if machine loses internet for ~10 min, session dies
4. **Must sign in via `/login`** (not API key)
5. **Can't add MCP servers while remote** -- configure everything before launching

---

## Feature 5: Session Teleportation (5 min)

### What It Is

Move sessions between your **local terminal** and **Anthropic's cloud infrastructure** -- in either direction. Fire-and-forget tasks to the cloud, then pull them back when they're done.

### Two Directions

**Terminal -> Cloud (`--remote`):**

```bash
# Fire off a task to the cloud
claude --remote "Fix the flaky test in auth.spec.ts"

# Multiple parallel cloud tasks
claude --remote "Fix the flaky test" &
claude --remote "Update the docs" &
claude --remote "Add error handling to payment module" &
```

**Cloud -> Terminal (`/teleport`):**

```bash
# Interactive picker of all web sessions
/teleport
/tp          # shorthand

# From CLI
claude --teleport              # interactive picker
claude --teleport <session-id> # specific session
```

### Live Demo

#### Step 1: Send a task to the cloud

```bash
claude --remote "Add input validation to all API endpoints in src/api/"
```

#### Step 2: Show it running on claude.ai

Open `claude.ai/code` in a browser -- show the session working.

#### Step 3: Check status from terminal

```bash
# Inside a Claude session:
/tasks
```

#### Step 4: Teleport it back to local

```
/tp
```

Select the session from the picker. Show the audience: Claude fetches the branch, checks it out, loads the full conversation history.

#### Step 5: Continue working locally

You now have the cloud session's changes + your full local environment (MCP servers, tools, configs).

### The Killer Pattern: Plan Locally, Execute Remotely

```bash
# Step 1: Plan in read-only mode
claude --permission-mode plan
# Collaborate on the approach, write the plan

# Step 2: Send the plan to cloud for execution
claude --remote "Execute the migration plan in docs/plan.md"

# Step 3: Monitor from phone (Remote Control) or web
# Step 4: Teleport back when done
/tp
```

### All Commands Reference

```bash
# === TERMINAL -> CLOUD ===
claude --remote "task description"     # Start cloud session with task

# === CLOUD -> TERMINAL ===
/teleport                              # Interactive session picker
/tp                                    # Shorthand
claude --teleport                      # CLI: interactive picker
claude --teleport <session-id>         # CLI: specific session

# === MONITORING ===
/tasks                                 # View all background/cloud sessions

# === ENVIRONMENT ===
/remote-env                            # Select cloud environment
```

### Requirements for Teleportation

| Requirement | Why |
|-------------|-----|
| Clean git state | No uncommitted changes (will prompt to stash) |
| Same repository | Must run from same repo checkout |
| Branch pushed | Cloud session's branch must exist on remote |
| Same account | Authenticated to same claude.ai account |

### Gotchas

1. **Session handoff is one-way per transfer** -- you can't "push" a running local session to the cloud. Use `--remote` to start a new cloud session.
2. **GitHub-only for `--remote`** -- no GitLab support yet
3. **Clean git state required** for `/tp` -- stash or commit first

---

## Quick Reference Card

Print this out or keep it on screen:

```
# AGENT TEAMS
  Enable:     CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (in settings.json)
  Shift+Down  Cycle to next teammate
  Shift+Up    Cycle to previous teammate
  Ctrl+T      Toggle task list view
  Shift+Tab   Toggle delegate mode

# GIT WORKTREES
  claude --worktree name         Named isolated session
  claude --worktree              Auto-named session
  claude --worktree name --tmux  With tmux pane

# /BATCH
  /batch <description>           Parallel codebase-wide change
  Approval gate before execution
  Each unit gets own worktree + /simplify review

# REMOTE CONTROL
  /rc                            Enable from inside session
  claude rc                      Start new session with RC
  /rename "name"                 Name session before RC
  /config                        Auto-enable for all sessions

# SESSION TELEPORTATION
  claude --remote "task"         Send task to cloud
  /tp                            Pull cloud session to local
  /tasks                         View all sessions

# UTILITY
  IS_DEMO=1                      Hide email in UI
  /fast                          Toggle fast mode
  /plan                          Enter plan mode
```

---

## Suggested Demo Flow

| # | Feature | Duration | Key Moment |
|---|---------|----------|------------|
| 1 | Agent Teams | 10 min | Split panes with 3 teammates working simultaneously |
| 2 | Git Worktrees | 5 min | Show isolation -- file exists in worktree but not in main tree |
| 3 | `/batch` | 8 min | Approval gate + parallel execution status table |
| 4 | Remote Control | 5 min | QR code scan + typing from phone appears in terminal |
| 5 | Session Teleportation | 5 min | `--remote` to cloud, `/tp` back to terminal |
| | **Total** | **~33 min** | + Q&A |

### Opening Line

> "Today we're covering the features that turned Claude Code from a terminal assistant into a multi-agent orchestration platform. Sixty-three releases in eight weeks."

### Closing Line

> "The paradigm shift in five words: decompose, isolate, monitor, review, clean up."

---

## Key Links

- [Official Claude Code Docs](https://code.claude.com/docs/en/)
- [Agent Teams Docs](https://code.claude.com/docs/en/agent-teams)
- [Remote Control Docs](https://code.claude.com/docs/en/remote-control)
- [Claude Code on the Web](https://code.claude.com/docs/en/claude-code-on-the-web)
- [Common Workflows (Worktrees)](https://code.claude.com/docs/en/common-workflows)
- [Building a C Compiler -- Anthropic Blog](https://www.anthropic.com/engineering/building-c-compiler)
