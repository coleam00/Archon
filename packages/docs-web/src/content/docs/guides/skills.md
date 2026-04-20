---
title: 노드별 Skills
description: Claude Agent SDK skills system을 사용해 개별 workflow node에 전문 지식을 미리 로드합니다.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 7
---

DAG workflow node는 named skills를 node의 agent context에 미리 로드하는 `skills` 필드를 지원합니다. 각 node는 다른 node를 오염시키지 않으면서 code review pattern, Remotion best practices, testing convention 같은 전문 절차 지식을 받습니다.

**Claude 전용** — Codex node는 warning을 출력하고 `skills` 필드를 무시합니다.

## 빠른 시작

1. skill을 설치합니다(예: official Remotion skill).

```bash
npx skills add remotion-dev/skills
```

이 명령은 SKILL.md file을 `.claude/skills/remotion-best-practices/`에 배치합니다.

2. workflow에서 이를 참조합니다.

```yaml
name: generate-video
description: Generate a Remotion video
nodes:
  - id: generate
    prompt: "Create an animated countdown video"
    skills:
      - remotion-best-practices
```

이것으로 끝입니다. node가 실행될 때 skill content가 agent context에 주입됩니다. 사용자가 prompt에 instructions를 붙여 넣지 않아도 agent는 animation pattern, API usage, gotchas 같은 skill knowledge를 참조할 수 있습니다.

## 동작 방식

node에 `skills: [name, ...]`이 있으면 executor는 이를 [AgentDefinition](https://platform.claude.com/docs/en/agent-sdk/subagents)으로 감쌉니다. 이는 skills를 subagents에 scope하는 Claude Agent SDK mechanism입니다.

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

agent가 skills를 invoke할 수 있도록 `Skill` tool이 `allowedTools`에 자동으로 추가됩니다. 수동으로 추가할 필요가 없습니다.

## Skills 설치

skills는 참조되기 전에 filesystem에 설치되어 있어야 합니다.

### skills.sh에서 설치(marketplace)

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

`.claude/skills/` 안에 `SKILL.md` file을 포함한 directory를 만듭니다.

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

skills는 ClaudeProvider에 설정된 `settingSources: ['project']`를 통해 다음 위치에서 발견됩니다.

| Location | Scope |
|----------|-------|
| `.claude/skills/` (in cwd) | Project-level |
| `~/.claude/skills/` | User-level(모든 프로젝트) |

`npx skills add`로 설치한 skills는 기본적으로 `.claude/skills/`에 들어갑니다. `~/.claude/skills/`에 global installation을 하려면 `-g`를 사용하세요.

## Scoping: Installed vs Active

**Installed** = skill이 disk에 존재합니다. Claude subprocess가 이를 발견할 수 있습니다.

**Active** = 특정 DAG node의 `skills:`에 나열되어 있습니다. 오직 **그 node**만 skill content를 context에 주입받습니다.

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

세 skill은 모두 disk에 설치되어 있습니다. 하지만 각 node는 필요한 것만 로드합니다. 이는 Stripe Minions 원칙인 "agents perform best when given a smaller box with a tastefully curated set of tools."를 따릅니다.

## Popular Skills

| Skill | Install | What It Teaches |
|-------|---------|----------------|
| `remotion-best-practices` | `npx skills add remotion-dev/skills` | Remotion animation patterns, API usage, gotchas(35 rules) |
| `skill-creator` | `npx skills add anthropics/skills` | 새 SKILL.md file을 만드는 방법 |
| Community skills | [skills.sh](https://skills.sh) 둘러보기 | 모든 domain에서 500K+ skills 검색 |

## node 하나에 여러 Skills 사용

하나의 node는 여러 skills를 가질 수 있습니다. 모두 주입됩니다.

```yaml
  - id: implement
    prompt: "Build the feature"
    skills:
      - code-conventions
      - testing-patterns
      - api-design
```

간결하게 유지하세요. 각 skill의 전체 content가 startup 시 context에 주입됩니다(progressive disclosure가 아님). agentskills.io spec은 SKILL.md를 500 lines / 5000 tokens 아래로 유지할 것을 권장합니다.

## Skills와 MCP 결합

skills와 MCP는 같은 node에서 자연스럽게 조합됩니다.

```yaml
  - id: create-pr
    prompt: "Create a PR with the changes"
    skills:
      - pr-conventions      # Teaches HOW to write good PRs
    mcp: .archon/mcp/github.json  # Provides the GitHub tools
```

skills는 **process**를 가르칩니다. MCP는 **capability**를 제공합니다. 둘을 함께 쓰면 각각을 단독으로 사용할 때보다 더 좋은 결과를 얻을 수 있습니다.

## Codex Compatibility

`skills`가 있는 Codex node는 warning을 log하고 skills 없이 계속 실행됩니다.

```
Warning: Node 'review' has skills set but uses Codex — per-node skills
are not supported for Codex.
```

skills를 사용하려면 node가 Claude를 사용하도록 하세요(default provider를 사용하거나 `provider: claude`를 명시적으로 설정).

## 제한사항

- **사전 설치 필요** — workflow가 실행되기 전에 skills가 disk에 존재해야 합니다. on-demand fetching은 아직 없습니다.
- **Claude 전용** — SDK의 `AgentDefinition.skills` 필드는 Claude-specific입니다.
- **Full injection** — skill content는 progressive disclosure가 아니라 startup 시 전체 주입됩니다. skills를 간결하게 유지하세요.
- **validation 없음** — named skill이 존재하지 않으면 SDK가 조용히 실패할 수 있습니다. `npx skills list`로 설치 여부를 확인하세요.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Skill not found | 설치되지 않음 | `npx skills add <source>` 실행 |
| Skill ignored | node가 Codex provider 사용 | node에 `provider: claude` 설정 |
| Too many skills | context budget 초과 | node당 가장 관련 있는 skills 2-3개로 줄이기 |
| Skill has no effect | description이 너무 모호함 | 구체적이고 실행 가능한 instructions로 SKILL.md 다시 작성 |

## 관련 문서

- [Inline sub-agents](/guides/authoring-workflows/#inline-sub-agents) — workflow-scoped sub-agents를 위한 `agents:` field(같은 node에서 `skills:`와 조합 가능하며, internal `dag-node-skills` wrapper와 ID collision이 나면 user-defined agents가 우선)
- [노드별 MCP Servers](/guides/mcp-servers/) — external tool access를 위한 `mcp:` field
- [Hooks](/guides/hooks/) — tool permission control을 위한 `hooks:` field
- [skills.sh](https://skills.sh) — skills를 발견하는 marketplace
- [agentskills.io](https://agentskills.io) — open SKILL.md standard
