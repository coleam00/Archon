# Rulecheck — Workshop Guide

## What This Skill Demonstrates

An autonomous code quality agent that combines **17 Claude Code features** into one
genuinely useful tool: custom agents, safety hooks, all four hook types (command,
prompt, http, agent), LLM-as-judge, persistent memory, Slack notifications, and
worktree isolation.

Replaces the existing advisory-only `code-rulecheck` agent with a fully autonomous
version that finds violations, fixes them, validates, creates PRs, and learns.

**Full demo steps**: See [part2-guide.md](../../workshop/part2-guide.md) — Feature 8.

## Architecture

```
User invokes /rulecheck [focus area]
        │
        ▼
┌──────────────────────────┐
│  SKILL.md                │  agent: rulecheck-agent
│  (orchestrator)          │  disable-model-invocation: true
│                          │  argument-hint: "[focus area]"
│  Launches agent,         │
│  reports results         │  NO context: fork
└────────┬─────────────────┘
         │ delegates to agent
         ▼
┌──────────────────────────┐
│  rulecheck-agent.md     │  isolation: worktree
│  (.claude/agents/)       │  background: true
│                          │  memory: project
│  model: sonnet           │  permissionMode: acceptEdits
│  maxTurns: 500           │
│                          │
│  hooks:                  │
│  ├─ PreToolUse [Bash]    │──→ block-dangerous.sh (safety gate)
│  ├─ PostToolUse [Edit]   │──→ bun run lint:fix (auto-fix)
│  └─ Stop                 │
│     ├─ command           │──→ slack-notify.sh (reads summary JSON)
│     ├─ http              │──→ POST to Slack webhook URL
│     └─ agent             │──→ meta-judge (LLM evaluation)
└────────┬─────────────────┘
         │ works in worktree
         ▼
┌──────────────────────────┐
│  Worktree                │
│  1. Read memory          │
│  2. Read CLAUDE.md rules │
│  3. Deep scan source     │
│  4. Group violations     │
│  5. Fix one group        │
│  6. bun run validate     │
│  7. Write summary JSON   │
│  8. gh pr create         │
│  9. Update memory        │
└──────────────────────────┘
         │
         ▼
   Results reported to main conversation
   + PR created + Slack notified + memory updated
```

## Features to Walk Through

### 1. `agent: rulecheck-agent` — Custom Agent Delegation (no fork)

**What is it?** The `agent:` field delegates to a custom agent with its own
system prompt, model, hooks, and memory configuration.

**In this skill**: The skill acts as an **orchestrator** — it launches the agent
and reports results. There is no `context: fork`. The skill stays active in the
main conversation while the agent runs in the background in its own worktree.

**Why no fork?** The rulecheck agent uses `background: true` and
`isolation: worktree`, so it already runs in a completely separate context.
Forking would add an unnecessary layer. The skill just launches and waits.

### 2. `disable-model-invocation: true` — User-Only Trigger

**What is it?** Prevents Claude from auto-invoking this skill. Since it creates
PRs and pushes branches (side effects), only the user should trigger it.

### 3. `argument-hint: "[focus area]"` — Usage Hint

**What is it?** Shows in `/help` and tab completion to tell users what arguments
the skill accepts. Optional — the agent works without arguments too.

### 4. `!`command`` — Dynamic Context Injection

**What is it?** Shell commands that execute at skill load time (before Claude sees
the prompt). Stdout replaces the placeholder.

**In this skill**: Injects current branch, recent git log, and lint status so the
agent starts with real context instead of having to fetch it.

### 5. Supporting Files — On-Demand Loading

**What is it?** Markdown files linked from the skill body with `[name](file.md)`.
Claude loads them only when needed, keeping the initial prompt small.

**In this skill**: `rules-guide.md` documents where to find rules and how to rank
violations. The agent loads it during the scan phase.

### 6. `isolation: worktree` — Git Worktree Isolation

**What is it?** The agent works in a temporary git worktree — a separate working
directory with its own branch. Changes are isolated from the main repo.

**In this skill**: The agent edits files and creates commits without affecting the
user's working directory. If something goes wrong, the worktree is disposable.

### 7. `background: true` — Concurrent Execution

**What is it?** The agent runs in the background. The user can continue working
in the main conversation while the agent scans, fixes, and creates a PR.

### 8. `memory: project` — Persistent Memory

**What is it?** The agent has a persistent memory directory at
`.claude/agent-memory/rulecheck-agent/`. It reads from and writes to `MEMORY.md`
across runs.

**In this skill**: The agent remembers what it fixed last time, what's in the
backlog, and meta-judge feedback — so each run builds on the previous one.

### 9. `permissionMode: acceptEdits` — Auto-Accept Edits

**What is it?** File edits (Edit/Write tools) are automatically approved without
user confirmation. Other tools still require approval per the normal flow.

**In this skill**: The agent needs to edit many files to fix violations. Prompting
for each edit would defeat the purpose of autonomous execution.

### 10. `maxTurns: 500` — Safety Cap

**What is it?** Limits the agent to 500 API round-trips. Prevents runaway agents
that loop endlessly. Set high here because the agent does a lot of work (scan,
fix, validate, commit, push, PR, memory update).

### 11. `hooks:` in Agent Frontmatter

**What is it?** Hooks defined directly in the agent's YAML frontmatter. They
activate whenever this agent runs, regardless of which skill invokes it.

This skill demonstrates all four hook types:

#### 11a. `type: "command"` — Shell Script Hooks

**PreToolUse [Bash]**: `block-dangerous.sh` reads the command from stdin, checks
against a blocklist (force push, git clean, hard reset, rm -rf), and exits 2 to
block dangerous commands.

**PostToolUse [Edit|Write]**: Runs `bun run lint:fix` after every file edit to
auto-correct formatting issues before they accumulate.

**Stop**: `slack-notify.sh` reads the agent's summary file and sends a formatted
Slack message with what was fixed, PR link, and remaining opportunities. This
demonstrates **inter-hook communication** — the agent writes a JSON file, the
hook reads it.

#### 11b. `type: "http"` — HTTP Webhook

**Stop**: POSTs the event directly to a Slack webhook URL. No script needed —
just a URL in the frontmatter. This is the simplest way to notify external
services. Compare with 11a above: the command hook gives you full control over
the message format, while the HTTP hook sends the raw event with zero code.

#### 11c. `type: "agent"` — LLM Meta-Judge

**Stop**: A third Stop hook spawns a subagent that evaluates the rulecheck's
execution. It reviews what was fixed, assesses prioritization quality, and writes
structured feedback to memory for the next run.

### 12. `statusMessage` — Hook Progress Indicators

**What is it?** A string shown in the Claude Code spinner while a hook runs.
Gives users visibility into what's happening during hook execution.

**In this skill**: "Checking command safety...", "Auto-fixing lint issues...",
"Notifying Slack...", "Posting run event to Slack...", "Running meta-judge evaluation..."

### 13. `$ARGUMENTS` — Skill Arguments

**What is it?** The text after the skill name (e.g., `/rulecheck error handling`)
is available as `$ARGUMENTS` in the skill body and passed through to the agent.

### 14. `${CLAUDE_SESSION_ID}` — Session Identifier

**What is it?** Environment variable with the current session ID. Used in the
meta-judge prompt to tag feedback with the session that produced it.

### 15. Summary File Pattern — Inter-Hook Communication

**What is it?** The agent writes `.claude/archon/rulecheck-last-run.json` as a
structured summary. The Slack hook reads this file to format its notification.

This is a practical pattern for passing data between the agent and its hooks
when the hook needs more than what's in the event JSON.

## Live Demo Steps

1. **Show the architecture** — open all files:
   - `.claude/skills/rulecheck/SKILL.md` (skill entry point)
   - `.claude/agents/rulecheck-agent.md` (the autonomous agent)
   - `.claude/skills/rulecheck/hooks/block-dangerous.sh` (safety gate)
   - `.claude/skills/rulecheck/hooks/slack-notify.sh` (Slack notification)
   - `.claude/skills/rulecheck/rules-guide.md` (supporting reference)

2. **Trace the delegation chain**:
   skill → `agent: rulecheck-agent` → `isolation: worktree` + `background: true`

3. **Show the hooks**: PreToolUse safety gate, PostToolUse lint auto-fix,
   Stop Slack (command + http) + meta-judge (agent)

4. **Test the safety hook**:
   ```bash
   echo '{"tool_input":{"command":"git push --force"}}' | .claude/skills/rulecheck/hooks/block-dangerous.sh
   # Should exit 2 with error message
   echo '{"tool_input":{"command":"bun run lint"}}' | .claude/skills/rulecheck/hooks/block-dangerous.sh
   # Should exit 0
   ```

5. **Invoke**: `/rulecheck type safety`
   - Show: background execution, user can keep working
   - Show: the agent scanning, fixing, validating in the worktree
   - Show: PR creation and Slack notification

6. **Show the outputs**:
   - PR on GitHub
   - Slack notification
   - Memory file (what was learned)
   - Meta-judge feedback

## Comparison: Before vs After

| | Advisory Code-Rulecheck | Autonomous Rulecheck |
|---|---|---|
| Format | `.claude/agents/code-rulecheck.md` | Skill + agent + hooks |
| Execution | Inline, blocks conversation | Background, worktree-isolated |
| Output | Advisory report (no changes) | Actual fixes + PR |
| Isolation | None (reads in-place) | Git worktree |
| Safety | None | PreToolUse command blocklist |
| Validation | None | `bun run validate` |
| Notifications | None | Slack (command hook + HTTP hook) |
| Learning | None | Persistent memory + meta-judge |
| Autonomy | Reports findings only | Finds, fixes, validates, PRs |

## Talking Points

- "This is 17 features in one skill. Each one is simple — the power is in composition."
- "The safety hook is a shell script. It reads JSON, checks a blocklist, exits 2 to block. No framework needed."
- "Memory makes the agent better over time. Each run builds on the last — it remembers what's in the backlog."
- "The meta-judge is an LLM evaluating another LLM. It writes structured feedback the agent reads next run."
- "Worktree isolation means the agent can break things safely. Your working directory is untouched."
- "Background execution means you keep working. The agent runs, creates a PR, notifies Slack — you review when ready."
- "The old code-rulecheck was advisory. This one actually fixes things. Same domain, fundamentally different capability."
