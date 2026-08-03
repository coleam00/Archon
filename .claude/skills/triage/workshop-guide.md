# Triage — Workshop Guide

## What This Skill Demonstrates

A command upgraded to a skill + custom agent pair, showcasing **context forking**,
**custom agent delegation**, **prompt hooks as guardrails**, and **restricted toolsets**.

**Full demo steps**: See [part2-guide.md](../../workshop/part2-guide.md) — Feature 7.

## Architecture

```
User invokes /triage 42
        │
        ▼
┌─────────────────────┐
│  SKILL.md           │  context: fork + agent: triage-agent
│  (entry point)      │  Injects repo context via !`command`
│  allowed-tools:     │  Restricts tools to gh CLI + read-only
│    Bash(gh *)       │
│    Read, Glob, Grep │
└────────┬────────────┘
         │ forks into isolated context
         ▼
┌─────────────────────┐
│  triage-agent.md    │  Custom agent with PostToolUse hook
│  (.claude/agents/)  │  Hook: type "prompt" validates every
│                     │  gh issue edit command to ensure
│  model: sonnet      │  all 4 label categories are present
│  hooks: PostToolUse │
└─────────────────────┘
         │
         ▼
   Summary returned to main conversation
   (intermediate tool calls discarded)
```

## Features to Walk Through

### 1. `context: fork` — Isolated Execution

**What is it?** A skill frontmatter field that runs the skill in a **new isolated
subagent context** instead of inline in the main conversation. The skill body
becomes the task prompt for the subagent. When the subagent finishes, only its
final response returns to the main conversation — all intermediate tool calls,
file reads, and reasoning are discarded.

**Key properties:**
- The forked context has **no access** to the main conversation history
- Only the **final summary** flows back — intermediate work is discarded
- `CLAUDE.md` files are still loaded in the forked context
- The fork cannot spawn further subagents (no nesting)
- Forked skills must contain **concrete tasks**, not just reference material

**In this skill**: Triaging 20 issues could consume 50K+ tokens of context
(issue bodies, label lists, grep results). Without forking, all of that pollutes
the main conversation. With forking, only the structured triage summary returns.

### 2. `agent: triage-agent` — Custom Agent Delegation

**What is it?** When a skill has `context: fork`, the `agent:` field controls
which agent type runs the forked context. Options:

| Agent | Model | Tools | Use case |
|-------|-------|-------|----------|
| `Explore` | Haiku (fast, cheap) | Read-only | File search, codebase exploration |
| `Plan` | Inherits from main | Read-only | Planning and research |
| `general-purpose` | Inherits from main | All tools | Complex multi-step tasks |
| Any custom agent | Whatever agent defines | Whatever agent defines | Domain-specific work |

Custom agents are `.md` files in `.claude/agents/` with their own frontmatter
(model, tools, hooks, memory, permissions) and a markdown body that serves as
the system prompt.

**In this skill**: Instead of `agent: general-purpose`, this skill delegates to
`triage-agent` — a custom agent defined in `.claude/agents/triage-agent.md` with:
- A triage specialist system prompt (label taxonomy, classification rules)
- Its own PostToolUse hook for label validation
- Restricted tool access

**Teaching moment**: Skills define *what* to do (scope, context, arguments).
Agents define *how* to do it (persona, tools, guardrails). Separating them
makes both composable — the same agent could be used by multiple skills.

### 3. `type: "prompt"` Hook — LLM as Guardrail

**What is it?** One of four hook handler types. A prompt hook sends the event
context to an LLM (Haiku by default) for a single-turn yes/no evaluation.
The LLM must return `{"ok": true}` to allow the action or
`{"ok": false, "reason": "..."}` to block it.

**How it differs from the other hook types:**
- `type: "command"` — runs a shell script, blocks via exit code 2
- `type: "http"` — POSTs JSON to a URL, blocks via JSON response
- `type: "prompt"` — asks an LLM to evaluate, blocks via `{"ok": false}`
- `type: "agent"` — spawns a subagent with Read/Grep/Glob to verify conditions

Prompt hooks are ideal for **semantic validation** — cases where the decision
requires understanding intent, not just pattern matching.

**In this skill**: The triage agent has a PostToolUse hook on Bash. When it
detects a `gh issue edit --add-label` command, the LLM verifies all four label
categories (type, effort, priority, area) are present.

**What happens if validation fails**: The LLM returns
`{"ok": false, "reason": "Missing effort label"}` and Claude receives that
feedback. It can fix the label application before moving to the next issue.

**Smart filtering**: The prompt instructs the LLM to return `{"ok": true}`
for non-label commands (`gh issue list`, `gh label list`) — no false positives.

### 4. `allowed-tools` — Restricted Toolset

**What is it?** A skill frontmatter field that controls which tools Claude can
use **without per-use permission prompts** when the skill is active. It acts as
both an allowlist (pre-approves listed tools) and a restriction (only these
tools are available in the forked context).

**Wildcard patterns** are supported:
- `Bash(gh *)` — only `gh` subcommands, no arbitrary shell
- `Bash(npm *)` — only npm commands
- `Read, Glob, Grep` — read-only codebase access

**In this skill**: `allowed-tools: Bash(gh *), Read, Glob, Grep` means the
agent can interact with GitHub and read the codebase, but can't run arbitrary
shell commands, write files, or edit code. This is a security boundary.

### 5. `disable-model-invocation: true`

**What is it?** Prevents Claude from auto-invoking this skill. By default, Claude
reads skill descriptions and can invoke them when it determines they're relevant.
Setting this to `true` means only the user can trigger it via `/triage`.

**In this skill**: Triage modifies GitHub issues (side effects). Only the user
should decide when to apply labels.

### 6. Dynamic Context Injection (`!`command``)

**What is it?** Shell commands in the skill body using `!`command`` syntax that
execute as preprocessing — before Claude sees the prompt. The command's stdout
replaces the placeholder. This is not tool use; it happens at skill load time.

**In this skill**: Three commands inject live repo data:
- Repository name (`gh repo view`)
- Open issue count (`gh issue list | length`)
- Existing label taxonomy (`gh label list`)

The agent starts with real context instead of instructions to go fetch it.

## Live Demo Steps

1. **Show the architecture** — open both files side by side:
   - `.claude/skills/triage/SKILL.md` (the skill entry point)
   - `.claude/agents/triage-agent.md` (the specialist agent)

2. **Point out the delegation chain**: skill → `context: fork` → `agent: triage-agent`

3. **Invoke on a single issue**: `/triage 42`
   - Show the `statusMessage` spinner: "Validating label application..."
   - Point out: the main conversation stays clean while triage happens in the fork

4. **Show the summary** that returns to the main conversation
   - All the intermediate work (fetching issues, reading code, applying labels) is gone
   - Only the structured summary survives

5. **Show the hook validation** — if a label application was incomplete, the prompt
   hook would have caught it and Claude would have self-corrected

## Comparison: Before vs After

| | Old Command | New Skill + Agent |
|---|---|---|
| Format | `.claude/commands/archon/triage.md` | Skill + `.claude/agents/triage-agent.md` |
| Execution | Inline (pollutes main context) | Forked (isolated context window) |
| Validation | None | Prompt hook validates every label application |
| Tool access | All Bash commands | `Bash(gh *)` only — no arbitrary shell |
| Agent persona | Generic | Specialized triage agent with domain knowledge |
| Context cost | All issue data stays in conversation | Only summary returns |

## Talking Points

- "Context forking is about information hygiene — the triage work happens in a disposable context."
- "Custom agents let you embed domain expertise. The triage rules live in the agent, the scope lives in the skill."
- "The prompt hook is an LLM guardrail — it catches incomplete label applications before they reach GitHub."
- "`Bash(gh *)` is a security boundary — the agent can interact with GitHub but can't run arbitrary commands."
- "This pattern — skill as entry point, custom agent as specialist — is how you build composable workflows."
