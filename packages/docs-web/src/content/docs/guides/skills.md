---
title: Per-Node Skills
description: Preload specialized knowledge into individual workflow nodes using the Claude Agent SDK skills system.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 7
---

DAG workflow nodes support a `skills` field that preloads named skills into the
node's agent context. Each node gets specialized procedural knowledge — code review
patterns, Remotion best practices, testing conventions — without polluting other nodes.

**Claude only** — Codex nodes will warn and ignore the `skills` field.

## Quick Start

1. Install a skill (e.g., the official Remotion skill):

```bash
npx skills add remotion-dev/skills
```

This places SKILL.md files in `.claude/skills/remotion-best-practices/`.

2. Reference it in your workflow:

```yaml
name: generate-video
description: Generate a Remotion video
nodes:
  - id: generate
    prompt: "Create an animated countdown video"
    skills:
      - remotion-best-practices
```

That's it. The skill's content is injected into the agent's context when the node
runs. The agent can reference the skill's knowledge (animation patterns, API usage,
gotchas) without the user having to paste instructions into the prompt.

## How It Works

When a node has `skills: [name, ...]`, the executor wraps it in an
[AgentDefinition](https://platform.claude.com/docs/en/agent-sdk/subagents) — the
Claude Agent SDK mechanism for scoping skills to subagents.

```
YAML: skills: [remotion-best-practices]
  ↓
Executor builds AgentDefinition:
  {
    description: "DAG node 'generate'",
    prompt: "You have preloaded skills: remotion-best-practices...",
    skills: ["remotion-best-practices"],
    tools: [...nodeTools, "Skill"]
  }
  ↓
SDK loads skill content into agent context at startup
  ↓
Agent executes with full skill knowledge available
```

The `Skill` tool is automatically added to `allowedTools` so the agent can invoke
skills. You don't need to add it manually.

## Installing Skills

Skills must be installed on the filesystem before they can be referenced.

### From skills.sh (marketplace)

```bash
# Install to current project
npx skills add remotion-dev/skills

# Install globally (all projects)
npx skills add remotion-dev/skills -g

# Install a specific skill from a multi-skill repo
npx skills add anthropics/skills --skill skill-creator

# Search for skills
npx skills find "database"
```

### From GitHub

```bash
# Public repo
npx skills add owner/repo

# Specific path in repo
npx skills add owner/repo/path/to/skill

# Private repo (uses SSH keys or GITHUB_TOKEN)
npx skills add git@github.com:org/private-skills.git
```

### Manual

Create a directory in `.claude/skills/` with a `SKILL.md` file:

```
.claude/skills/my-skill/
└── SKILL.md
```

SKILL.md format:

```yaml
---
name: my-skill
description: What this skill does and when to use it
---

# Instructions

Step-by-step content here. The agent loads this when the skill activates.
```

## Skill Discovery

Skills are discovered from these locations (via `settingSources: ['project']`
set in ClaudeProvider):

| Location | Scope |
|----------|-------|
| `.claude/skills/` (in cwd) | Project-level |
| `~/.claude/skills/` | User-level (all projects) |

Skills installed via `npx skills add` land in `.claude/skills/` by default.
Use `-g` for global installation to `~/.claude/skills/`.

## Scoping: Installed vs Active

**Installed** = the skill exists on disk. It's discoverable by the Claude subprocess.

**Active** = listed in `skills:` on a specific DAG node. Only THAT node gets the
skill content injected into its context.

```yaml
nodes:
  - id: classify
    prompt: "Classify this task"
    # No skills — fast, cheap, no extra context

  - id: implement
    prompt: "Write the code"
    skills: [code-conventions, testing-patterns]
    # Gets both skills injected — deeper domain knowledge

  - id: review
    prompt: "Review the code"
    skills: [code-review]
    # Gets a different skill — review-focused expertise
```

All three skills are installed on disk. But each node only loads what it needs.
This follows the Stripe Minions principle: "agents perform best when given a
smaller box with a tastefully curated set of tools."

## Popular Skills

| Skill | Install | What It Teaches |
|-------|---------|----------------|
| `remotion-best-practices` | `npx skills add remotion-dev/skills` | Remotion animation patterns, API usage, gotchas (35 rules) |
| `skill-creator` | `npx skills add anthropics/skills` | How to create new SKILL.md files |
| Community skills | Browse [skills.sh](https://skills.sh) | Search 500K+ skills for any domain |

## Multiple Skills Per Node

A node can have multiple skills. All are injected:

```yaml
  - id: implement
    prompt: "Build the feature"
    skills:
      - code-conventions
      - testing-patterns
      - api-design
```

Keep it concise — each skill's full content is injected into context at startup
(not progressive disclosure). The agentskills.io spec recommends keeping SKILL.md
under 500 lines / 5000 tokens.

## Combining Skills with MCP

Skills and MCP compose naturally on the same node:

```yaml
  - id: create-pr
    prompt: "Create a PR with the changes"
    skills:
      - pr-conventions      # Teaches HOW to write good PRs
    mcp: .archon/mcp/github.json  # Provides the GitHub tools
```

Skills teach the **process**. MCP provides the **capability**. Together they
produce better results than either alone.

## Codex Compatibility

Codex nodes with `skills` log a warning and continue without the skills:

```
Warning: Node 'review' has skills set but uses Codex — per-node skills
are not supported for Codex.
```

To use skills, ensure the node uses Claude (the default provider, or set
`provider: claude` explicitly).

## Limitations

- **Pre-installation required** — skills must exist on disk before the workflow runs.
  There is no on-demand fetching (yet).
- **Claude only** — the SDK's `AgentDefinition.skills` field is Claude-specific.
- **Full injection** — skill content is fully injected at startup, not progressively
  disclosed. Keep skills concise.
- **No validation** — if a named skill doesn't exist, the SDK may fail silently.
  Verify skills are installed with `npx skills list`.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Skill not found | Not installed | Run `npx skills add <source>` |
| Skill ignored | Node uses Codex provider | Set `provider: claude` on the node |
| Too many skills | Context budget exceeded | Reduce to 2-3 most relevant skills per node |
| Skill has no effect | Description too vague | Rewrite SKILL.md with specific, actionable instructions |

## Related

- [Per-Node MCP Servers](/guides/mcp-servers/) — `mcp:` field for external tool access
- [Hooks](/guides/hooks/) — `hooks:` field for tool permission control
- [skills.sh](https://skills.sh) — marketplace for discovering skills
- [agentskills.io](https://agentskills.io) — the open SKILL.md standard
