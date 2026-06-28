---
name: archon-workflow-creator
description: >-
  Create, edit, review, and validate Archon workflow YAML files for `.archon/workflows/`.
  Use when the user asks to build an Archon workflow, generate workflow YAML, configure Archon workflow nodes, add commands or scripts for workflows, choose provider/model/thinking settings, use every Archon node type, or debug workflow validation errors.
  This skill gives the workflow schema, node types, provider/model/thinking rules, examples, and validation workflow so agents do not need to scout the Archon source code first.
---

# Archon Workflow Creator

## Overview

Use this skill to author Archon DAG workflows from user intent through validated YAML.
The goal is to produce workflows that pass Archon's local validator and behave correctly at runtime.

## Authoring Workflow

1. Clarify the workflow objective, trigger phrases, expected input, generated artifacts, provider preferences, and whether human approval is needed.
2. Inspect only project-level context that affects authoring: `.archon/workflows/`, `.archon/commands/`, `.archon/scripts/`, `.archon/config.yaml`, `package.json`, and existing project conventions.
3. Read `references/workflow-anatomy.md` before creating or editing workflow YAML.
4. Read `references/node-types.md` before configuring nodes or when validation mentions node schema, dependencies, conditions, retry, hooks, agents, skills, MCP, or output refs.
5. Read `references/providers-models-thinking.md` whenever the workflow mentions provider, model, tier, alias, thinking, reasoning, effort, tools, MCP, skills, agents, sandbox, or structured output.
6. Read `references/examples.md` when you need copyable YAML patterns.
7. Read `references/validation.md` before finalizing and run the relevant validation command.

## Default Output

Create project workflows under `.archon/workflows/<workflow-name>.yaml`.
Create reusable prompts under `.archon/commands/<command-name>.md` when the prompt is long, shared, or independently testable.
Create deterministic helper scripts under `.archon/scripts/` when shell would be brittle, especially for JSON parsing or cross-platform logic.

## Hard Rules

- Use `nodes:`, never legacy `steps:`.
- Give every node a unique safe ID and exactly one action key: `prompt`, `command`, `bash`, `script`, `loop`, `route_loop`, `approval`, or `cancel`.
- Prefer `output_format` for AI nodes whose output is consumed by later nodes.
- Use deterministic `bash` or `script` nodes for checks, setup, parsing, file moves, and final assertions.
- Use `allowed_tools: []` on classifier or formatting nodes that should not touch the repo.
- Use `context: fresh` when an AI node should not inherit the previous sequential AI session.
- Use `interactive: true` at the workflow root when approval nodes or interactive loops must be foreground-visible.
- Validate with `bun run cli validate workflows <workflow-name>` before reporting success.
- Inspect workflow engine source only if local validation contradicts these references or the project clearly changed after this skill was written.

## Reference Map

- `references/workflow-anatomy.md` - File locations, root fields, discovery precedence, variables, and model refs.
- `references/node-types.md` - Every node type and every important common node option.
- `references/providers-models-thinking.md` - Provider IDs, capabilities, config, model tiers, aliases, effort, and thinking.
- `references/examples.md` - Copyable workflow snippets for common patterns.
- `references/validation.md` - Validation commands, common failures, and final checklist.
