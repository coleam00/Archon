---
title: Provider Capability Matrix
description: Canonical per-provider capability matrix, generated from each provider capabilities.ts.
category: reference
area: clients
audience: [user, developer]
status: current
sidebar:
  order: 10
---

<!-- AUTO-GENERATED — DO NOT EDIT. Regenerate with: bun run generate:capability-matrix -->

:::note
This page is **auto-generated** from each provider's `capabilities.ts` (the same
constants the workflow engine reads to warn when a node uses a feature its
provider ignores). Do not edit it by hand — run `bun run generate:capability-matrix`.
A capability change fails `bun run validate` until this page is regenerated.
:::

Each column is a registered provider id (the value you set as `provider:` in a
workflow or `.archon/config.yaml`). A ✅ means Archon translates the corresponding
per-node YAML field for that provider; a ❌ means the field is accepted but ignored
(the dag-executor emits a visible warning when the run reaches such a node).

## Providers

- `claude` — Claude (Anthropic)
- `codex` — Codex (OpenAI)
- `opencode` — OpenCode (community) *(community provider)*
- `pi` — Pi (community) *(community provider)*
- `copilot` — Copilot (GitHub) *(community provider)*

## Capabilities

| Capability | `claude` | `codex` | `opencode` | `pi` | `copilot` |
| --- | --- | --- | --- | --- | --- |
| Session resume | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP servers (`mcp:`) | ✅ | ✅ | ✅ | ❌ | ✅ |
| Hooks (`hooks:`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Skills (`skills:`) | ✅ | ✅¹ | ✅ | ✅ | ✅ |
| Inline sub-agents (`agents:`) | ✅ | ❌ | ✅² | ❌ | ✅ |
| Tool restrictions (`allowed_tools`/`denied_tools`) | ✅ | ❌ | ✅ | ✅ | ✅ |
| Structured output (`output_format`) | **enforced** | **enforced** | **enforced** | best-effort | best-effort |
| Env injection (`env:`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cost control (`maxBudgetUsd`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Effort control (`effort`) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Thinking control (`thinking`) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Fallback model (`fallbackModel`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Sandbox (`sandbox`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| In-process native tools | ✅ | ❌ | ❌ | ✅ | ❌ |
| Container exec (folder-project container backend) | ✅ | ❌ | ❌ | ❌ | ❌ |

## Caveats

- ¹ `codex` — Skills (`skills:`) — Filesystem auto-discovery from `.agents/skills/` — per-node `skills:` lists are informational; use `provider: claude` for node-scoped skills.
- ² `opencode` — Inline sub-agents (`agents:`) — Config-file-based agent selection (named agents from `opencode.json`) with per-call model/tools overrides — not inline sub-agent definitions.

## Legend

- **✅ / ❌** — the per-node field is wired for this provider, or accepted-but-ignored.
- **✅¹ (superscript)** — supported, but with semantics that differ from the headline
  meaning of the axis — see [Caveats](#caveats).
- **Structured output** — `enforced` (the SDK/backend grammar-constrains decoding),
  `best-effort` (schema appended to the prompt, then validated + re-asked up to 3×),
  or ❌ (unsupported). See [AI Assistants → Structured output guarantees](/getting-started/ai-assistants/#structured-output-guarantees).
- **In-process native tools** — the provider can register Archon `NativeTool`s for a
  turn (gates auto-injection of Archon's `manage_run` tool into project-scoped chat).

For per-provider field-level notes (YAML syntax, caveats), see the
[AI Assistants guide](/getting-started/ai-assistants/).
