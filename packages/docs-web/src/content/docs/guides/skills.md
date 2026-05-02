---
title: Per-Node Skills
description: Preload specialized knowledge into individual workflow nodes.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 8
---

DAG workflow nodes support a `skills` field that preloads named skills into the
node's agent context. Each node gets specialized procedural knowledge — code review
patterns, Remotion best practices, testing conventions — without polluting other nodes.

## Quick Start

1. Install a skill (e.g., the official Remotion skill):

```bash
npx skills add remotion-dev/skills
```

This places SKILL.md files in `.claude/skills/remotion-best-practices/`.
Codex-style skills can also live in `.agents/skills/`.

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

When a node has `skills: [name, ...]`, Archon resolves each selected skill before
the node runs. Missing or unreadable skills fail validation with the searched
paths.

### Claude

For Claude nodes, the executor wraps the node in an
[AgentDefinition](https://platform.claude.com/docs/en/agent-sdk/subagents), the
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

### Codex

For Codex nodes, Archon resolves the selected `SKILL.md` files and prepends them
to the Codex turn as explicit workflow-selected skill context. This makes
`skills:` deterministic even when the skill lives outside Codex's native
auto-discovery roots.

Codex can also use its native `$skill-name` invocation for skills installed under
`.agents/skills/` or user/admin/system Codex roots. The workflow `skills:` field
is for selecting exactly which skills a node should receive.

### Pi

For Pi nodes, Archon resolves skill names to skill directories and passes them to
Pi as additional skill paths.

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

Create a directory in `.claude/skills/` or `.agents/skills/` with a `SKILL.md`
file:

```
.agents/skills/my-skill/
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

Skills are discovered from these default locations:

| Location | Scope |
|----------|-------|
| `.agents/skills/` (in cwd) | Project-level, Codex/Pi convention |
| `.codex/skills/` (in cwd) | Project-level, Codex convention |
| `.claude/skills/` (in cwd) | Project-level |
| `~/.agents/skills/` | User-level Codex/Pi convention |
| `~/.codex/skills/` | User-level Codex convention |
| `~/.claude/skills/` | User-level (all projects) |
| `/etc/codex/skills/` | Admin/system Codex convention |

Codex nodes can add extra roots in config:

```yaml
assistants:
  codex:
    skillRoots:
      - /absolute/path/to/team-skills
```

Skill entries can also be explicit paths to a skill directory or a `SKILL.md`
file:

```yaml
skills:
  - /absolute/path/to/team-skills/release-checklist
  - ./.agents/skills/local-skill/SKILL.md
```

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
| `archon` (bundled) | `archon skill install` | Archon workflows, commands, and project conventions |
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

Codex supports `skills:` on workflow prompt and command nodes. Archon injects the
resolved skill content into the Codex turn, so missing skills fail before the
model runs instead of being silently ignored.

## Limitations

- **Pre-installation required** — skills must exist on disk before the workflow runs.
  There is no on-demand fetching (yet).
- **Full injection** — skill content is fully injected at startup, not progressively
  disclosed. Keep skills concise.
- **Provider mechanics differ** — Claude uses SDK `AgentDefinition.skills`, Codex
  receives explicit skill context in the turn prompt, and Pi receives additional
  skill paths.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Skill not found | Not installed | Run `npx skills add <source>` |
| Skill not found in custom location | Root not configured | Add `assistants.codex.skillRoots` or reference the skill by explicit path |
| Too many skills | Context budget exceeded | Reduce to 2-3 most relevant skills per node |
| Skill has no effect | Description too vague | Rewrite SKILL.md with specific, actionable instructions |

## Related

- [Inline sub-agents](/guides/authoring-workflows/#inline-sub-agents) — `agents:` field for workflow-scoped sub-agents (composes with `skills:` on the same node; user-defined agents win on ID collision with the internal `dag-node-skills` wrapper)
- [Per-Node MCP Servers](/guides/mcp-servers/) — `mcp:` field for external tool access
- [Hooks](/guides/hooks/) — `hooks:` field for tool permission control
- [skills.sh](https://skills.sh) — marketplace for discovering skills
- [agentskills.io](https://agentskills.io) — the open SKILL.md standard
