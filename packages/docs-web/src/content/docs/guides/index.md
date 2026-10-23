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

- [Build your first workflow](/getting-started/first-workflow/) — Build, validate, dry-run and test a workflow with an approval gate
- [Workflow language](/reference/workflow-language/) — Every workflow field, node type and engine behavior
- [Authoring Commands](/guides/authoring-commands/) — Write prompt templates that serve as building blocks for workflow nodes

## Node Types

- [Loop Nodes](/guides/loop-nodes/) — Iterative AI execution with completion conditions and deterministic exit checks
- [Approval Nodes](/guides/approval-nodes/) — Human review gates with optional AI rework on rejection
- [Script Nodes](/guides/script-nodes/) — TypeScript/JavaScript (bun) or Python (uv) as a deterministic DAG node, without AI

## Automation

- [Workflow Triggers](/guides/workflow-triggers/) — Start workflows from schedules and verified GitHub events
- [Proactive Workflows](/guides/proactive-workflows/) — Let a cheap agent decide whether an event matters, then keep a person on the loop before the run acts

## Node Features

Support varies by provider. See the [provider capability matrix](/reference/provider-capabilities/) for each feature.

- [Per-Node Hooks](/guides/hooks/) — Attach Claude SDK hooks for tool control, context injection, and input modification
- [Per-Node MCP Servers](/guides/mcp-servers/) — Connect external tools (GitHub, Postgres, etc.) to individual nodes
- [Per-Node Skills](/guides/skills/) — Preload specialized knowledge into node agents

## Bundled Workflows

Archon ships the `sdlc` workflow pack, a software factory from an incoming issue to a merged pull request. [Set up the SDLC factory](/getting-started/sdlc-factory/) runs it on your repository, and [SDLC pack workflows](/reference/sdlc-workflows/) describes each workflow.

To customize the pack, copy the whole `.archon/workflows/sdlc/` folder from the Archon repository into your project's `.archon/workflows/` and modify it -- same-named workflows override the bundled ones. Copy the pack rather than one workflow folder: its workflows include each other and share scripts in `sdlc/.shared/`.

## Advanced

- [Global Workflows](/guides/global-workflows/) — User-level workflows that apply to every project
- [Multi-Repo Projects](/guides/multi-repo-projects/) — Drive many service repos under one folder-project root
