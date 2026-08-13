---
title: Per-Node Skills
description: Select specialized knowledge for individual workflow nodes using provider-native skill systems.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 8
---

DAG workflow nodes support a `skills` field for providers that can load named skills
for one node. Each node can receive specialized procedural knowledge — code review
patterns, Remotion practices, testing conventions — without advertising it to every
other node.

Delivery is provider-specific. Claude, Pi, and Copilot consume the per-node list.
Codex workflow nodes deliberately suppress Codex's automatic filesystem-skill catalog;
authors invoke an installed skill explicitly in the command or prompt with
`$skill-name`. OpenCode does not currently implement the top-level YAML field. Check
the [provider capability matrix](/reference/provider-capabilities/) before relying on
portable behavior.

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

For Codex, also invoke the skill explicitly in the node body, preferably in a named
command file. First install it into Codex's native `.agents/skills/` root:

```bash
npx skills add remotion-dev/skills --agent codex --skill remotion-best-practices -y
```

Then invoke it from the workflow body:

```markdown
Use $remotion-best-practices to create the requested video.
```

Codex then loads the original `SKILL.md` and resolves its relative references,
scripts, and assets from the installed directory.

## How It Works

Claude workflow nodes use the Agent SDK's native skill selector. Archon keeps
Claude's normal project/user setting sources so `CLAUDE.md` and agents still
load, while selecting only the skills named by the node.

```
YAML: skills: [remotion-best-practices]
  ↓
Claude SDK options:
  skills: ["remotion-best-practices"]
  strictMcpConfig: true
  ↓
SDK advertises only that declared skill to the model
  ↓
Agent invokes the skill progressively through the Skill tool
```

The `Skill` tool is automatically added to `allowedTools` so the agent can invoke
skills. You don't need to add it manually.

On Claude, omission and `skills: []` both select no skills. A non-empty list is
an exact allowlist of installed Claude-native skills for that node. The separate
`settingSources` default remains `['project', 'user']`, preserving project/user
instructions and agents without making their ambient skills available. A declared
skill must still live under an enabled source: project skills require `project`,
user-global skills require `user`, and `settingSources: []` cannot be combined with
a non-empty `skills:` list. Archon checks this before starting the provider.

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

Skills are discovered from these locations (via the default
`settingSources: ['project', 'user']` set in ClaudeProvider):

| Location | Scope |
|----------|-------|
| `.claude/skills/` (in cwd) | Project-level |
| `~/.claude/skills/` | User-level (all projects) |

Set `assistants.claude.settingSources: ['project']` in `.archon/config.yaml`
when you also want to exclude user-level instructions and agents. Skill selection
itself remains exact per node, but a user-global declared skill is unavailable when
the `user` source is disabled.

Skills installed via `npx skills add` land in `.claude/skills/` by default.
Use `-g` for global installation to `~/.claude/skills/`.

## Scoping: Installed vs Active

**Installed** = the skill exists under a provider-native directory on disk.

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

All three skills are installed on disk. But each node only advertises and loads
what it declares.
This follows the Stripe Minions principle: "agents perform best when given a
smaller box with a tastefully curated set of tools."

## Popular Skills

| Skill | Install | What It Teaches |
|-------|---------|----------------|
| `archon` (bundled) | `archon skill install` | Archon workflows, commands, and project conventions |
| `manage-run` (bundled) | `archon skill install` | Inspect and control workflow runs via the `archon` CLI (focused run-management skill) |
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

Keep the list concise. Claude first receives declared skill metadata and loads the
selected `SKILL.md` through its Skill tool when needed.

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

Codex supports installed skills through native filesystem discovery from
`<project>/.agents/skills/` and its user-level Codex roots. It does not natively
discover `.claude/skills/`.

For every Codex-backed workflow AI node, Archon disables the automatic skill catalog.
This prevents description matching from spontaneously selecting an unrelated ambient
skill. Direct Codex chat and other non-workflow calls keep their normal Codex behavior.

- **Explicit invocation is required** — write `Use $skill-name to ...` in the
  command file or prompt. Codex performs progressive disclosure and loads the
  selected skill from its original directory.
- **YAML `skills:` is not Codex activation** — a non-empty list does not re-enable
  the automatic catalog, inject metadata, or create an exclusive allowlist. It is
  ignored with a warning. Keep the list when another selected provider needs it,
  but still write the explicit `$skill-name` invocation for Codex portability.
- **Omission and `skills: []`** — both keep the automatic catalog off on Codex
  workflow nodes. Exact-loading providers interpret `[]` as an empty declared set.
- **SKILL.md format** — Codex parses the same `name`/`description` frontmatter
  as Claude Code. Any Claude-specific `!bash` execution lines in a skill body
  are treated as literal text by Codex (no error, no execution).
- **Behavioral boundary, not filesystem security** — an explicit request for an
  ambient `$skill-name` can still activate that installed skill. Archon prevents
  automatic advertisement; it does not hide or move files.
- **External future binaries** — if a Codex version rejects the catalog-suppression
  config, Archon warns and continues with native discovery instead of rejecting the run.

Normal repository instructions such as `AGENTS.md` remain active with the catalog off.

## Limitations

- **Pre-installation required** — skills must exist on disk before the workflow runs.
  There is no on-demand fetching (yet).
- **Provider-native paths** — Claude declarations resolve only from project/user
  `.claude/skills/`; Archon does not copy `.agents/skills/` into Claude's roots.
- **Container workflows** — only project-local `.claude/skills/` is visible in the
  isolated runner. A host user-global skill must also be installed in the project
  before a container node can declare it; Archon fails before provider spend otherwise.
- **Provider semantics differ** — consult the capability matrix. Codex uses explicit
  `$skill-name` invocation rather than YAML list injection.
- **Fail-fast validation** — a Claude node that declares a skill unavailable from
  its native roots fails before the provider query starts.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Claude skill not found | Not installed in a Claude-native root | Run `npx skills add <source>` for Claude, or create `.claude/skills/<name>/SKILL.md` |
| Codex does not use a skill | Automatic catalogs are off in workflow nodes | Invoke it explicitly in the command/prompt with `$skill-name` and install it under a Codex-native root such as `.agents/skills/` |
| Codex warns about `skills:` | Codex does not implement the YAML list | Keep the list only for other providers; use `$skill-name` for Codex |
| Too many skills | Context budget exceeded | Reduce to 2-3 most relevant skills per node |
| Skill has no effect | Description too vague | Rewrite SKILL.md with specific, actionable instructions |

## Related

- [Inline sub-agents](/guides/authoring-workflows/#inline-sub-agents) — `agents:` field for workflow-scoped sub-agents (composes independently with native per-node skill selection)
- [Per-Node MCP Servers](/guides/mcp-servers/) — `mcp:` field for external tool access
- [Hooks](/guides/hooks/) — `hooks:` field for tool permission control
- [skills.sh](https://skills.sh) — marketplace for discovering skills
- [agentskills.io](https://agentskills.io) — the open SKILL.md standard
