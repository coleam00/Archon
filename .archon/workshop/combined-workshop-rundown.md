# Combined Workshop Rundown

**Host**: Rasmus (Thomas prepped the platform features section)
**Duration**: ~70 min + Q&A
**Required**: Claude Code v2.1.63+, Max plan, tmux, GitHub CLI (`gh`)

---

## Pre-Workshop Setup (both hosts)

```bash
claude --version          # Must be v2.1.63+
tmux -V                   # Required for split panes
gh auth status            # Required for triage + /batch
export IS_DEMO=1          # Hide email/org in UI
```

`~/.claude/settings.json`:
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

---

## Part 1 — Platform Features (~33 min)

The "what Claude Code can do now" half. Shows the multi-agent orchestration
platform that shipped in Jan-Feb 2026. (Prepped by Thomas.)

**Follow the full guide**: [part1-guide.md](part1-guide.md) — contains all
copy-paste prompts, comparison tables, ASCII diagrams, keyboard shortcuts,
gotchas, and example commands.

**Section summary** (see part1-guide.md for full demo steps):

1. **Agent Teams** (10 min) — Split panes, shared task list, teammate messaging, delegate mode
2. **Native Git Worktrees** (5 min) — `--worktree` CLI flag, isolation proof, auto-cleanup
3. **`/batch`** (8 min) — Decomposition plan, approval gate, parallel execution, PR per unit
4. **Remote Control** (5 min) — `/rc`, QR code, phone connection, code stays local
5. **Session Teleportation** (5 min) — `--remote` to cloud, `/tp` back to local

---

## Transition (~2 min)

> "That was the platform — what Claude Code can do out of the box. Now let's
> look at how to build your own power on top of it — custom skills, agents,
> hooks, and autonomous workflows. Same building blocks, composed into
> something new."

---

## Part 2 — Extensibility: Skills, Agents & Hooks (~35 min)

The "how to extend Claude Code yourself" half. Three skills, progressive
complexity, each building on the previous. (Prepped by Rasmus.)

**Follow the full guide**: [part2-guide.md](part2-guide.md) — contains all
copy-paste prompts, feature tables, architecture diagrams, bash commands,
talking points, and cleanup steps. Runs on this codebase (`coleam00/Archon`).

**Section summary** (see part2-guide.md for full demo steps):

6. **save-task-list** (10 min) — Skills system, hook types (prompt + command), `once: true`, SessionStart hooks, dynamic context injection
7. **triage** (10 min) — `context: fork`, custom agent delegation, `allowed-tools` wildcards, prompt hook as LLM guardrail
8. **rulecheck** (15 min) — Full autonomy: worktree isolation, background execution, persistent memory, 4 hook types (command + prompt + http + agent), meta-judge, safety gate, Slack notifications
9. **Auto-Memory** (2 min) — `/memory`, agent memory directory, cross-worktree sharing

---

## Closing (~2 min)

> "Part 1 was the platform: teams, worktrees, batch, remote control,
> teleportation. Part 2 was the extensibility layer: skills, agents, hooks,
> memory, safety gates. Together, that's the full picture — use the platform,
> and extend it for your specific workflows."

> "The paradigm shift: decompose, isolate, extend, review, learn."

---

## Combined Feature Count

| Section | Features shown |
|---------|---------------|
| Thomas (platform) | ~8 major features |
| Rasmus (extensibility) | ~25 features across 3 skills |
| **Total unique features** | **~30** |
| Overlap | Worktree isolation (CLI vs agent frontmatter) |

---

## Quick Reference Card

```
# PLATFORM (Thomas)
  Agent Teams          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
  Shift+Down/Up        Cycle teammates
  Ctrl+T               Task list
  Shift+Tab            Delegate mode
  claude --worktree    Isolated session
  /batch <desc>        Parallel codebase change
  /rc                  Remote control
  /tp                  Teleport cloud -> local
  claude --remote      Local -> cloud

# EXTENSIBILITY (Rasmus)
  Skills               .claude/skills/<name>/SKILL.md
  Agents               .claude/agents/<name>.md
  Hooks (command)      type: command, exit 2 to block
  Hooks (prompt)       type: prompt, {"ok": false} to block
  Hooks (agent)        type: agent, subagent evaluator
  context: fork        Isolated execution, only summary returns
  isolation: worktree  Agent gets its own worktree
  background: true     Agent runs concurrently
  memory: project      Persistent across runs
  allowed-tools        Security boundary (e.g., Bash(gh *))
  once: true           Fire hook exactly once
  statusMessage        Custom spinner text
  !`command`           Dynamic context at load time
  $ARGUMENTS           User input passthrough
```
