---
title: Guides
description: How-to guides for authoring workflows, commands, and configuring node features in Archon.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 0
---

How-to guides for building and running AI coding workflows with Archon.

## Workflow Authoring

- [Authoring Workflows](/guides/authoring-workflows/) — Create multi-step YAML workflows with DAG nodes, conditional branching, and parallel execution
- [Authoring Commands](/guides/authoring-commands/) — Write prompt templates that serve as building blocks for workflow nodes

## Node Types

- [Loop Nodes](/guides/loop-nodes/) — Iterative AI execution with completion conditions and deterministic exit checks
- [Approval Nodes](/guides/approval-nodes/) — Human review gates with optional AI rework on rejection
- [Script Nodes](/guides/script-nodes/) — TypeScript/JavaScript (bun) or Python (uv) as a deterministic DAG node, without AI

## Node Features (Claude only)

- [Per-Node Hooks](/guides/hooks/) — Attach Claude SDK hooks for tool control, context injection, and input modification
- [Per-Node MCP Servers](/guides/mcp-servers/) — Connect external tools (GitHub, Postgres, etc.) to individual nodes
- [Per-Node Skills](/guides/skills/) — Preload specialized knowledge into node agents

## Bundled Workflows

Archon ships the `sdlc` workflow pack, which covers the software development lifecycle from an incoming issue to a reviewed pull request. You do not need to write any YAML to use these -- just describe what you want and the router picks the right one.

| Workflow | What It Does |
|----------|-------------|
| `archon-ship` | Triage an issue or request, investigate or plan as needed, then deliver a reviewed PR |
| `archon-triage` | Check an issue against the current code and decide what it needs next |
| `archon-investigate` | Prove the root cause of a bug or open question |
| `archon-plan` | Turn decided intent into an implementable plan |
| `archon-implement` | Build decided work until the project's checks pass (commits, no PR) |
| `archon-pr` | Open a pull request for committed work |
| `archon-deliver` | Implement, open a draft PR, review, fix findings, validate, and flip it ready |
| `archon-review` | Review a PR or the working diff through parallel specialist lenses |
| `archon-validate` | Run the project's own checks and report a verdict |
| `archon-upkeep` | Update one dependency through the reviewed delivery tail |

For usage examples and guidance on which one to pick, see [The Essential Workflows](/book/essential-workflows/).

To customize the pack, copy the whole `.archon/workflows/sdlc/` folder from the Archon repository into your project's `.archon/workflows/` and modify it -- same-named workflows override the bundled ones. Copy the pack rather than one workflow folder: its workflows include each other and share scripts in `sdlc/.shared/`.

## Advanced

- [Global Workflows](/guides/global-workflows/) — User-level workflows that apply to every project
- [Multi-Repo Projects](/guides/multi-repo-projects/) — Drive many service repos under one folder-project root
