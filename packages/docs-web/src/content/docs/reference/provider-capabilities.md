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
constants the workflow engine reads to enforce provider-specific behavior). Do not
edit it by hand — run `bun run generate:capability-matrix`.
A capability change fails `bun run validate` until this page is regenerated.
:::

Each column is a registered provider id (the value you set as `provider:` in a
workflow or `.archon/config.yaml`). A ✅ means Archon translates the corresponding
capability for that provider; a ❌ means the capability is unsupported. Unsupported
behavior is feature-specific: some optional fields are ignored with a warning, while
strict contracts fail closed. In particular, `context.resume` rejects an explicitly
unsupported provider at load time and an implicitly resolved one at runtime.

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
| Immutable session fork (`context.resume`) | ✅ | ❌ | ❌ | ✅ | ❌ |
| MCP servers (`mcp:`) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Hooks (`hooks:`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Skills (`skills:`) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Inline sub-agents (`agents:`) | ✅ | ❌ | ✅¹ | ❌ | ✅ |
| Tool restrictions (`allowed_tools`/`denied_tools`) | ✅ | ❌ | ✅ | ✅ | ✅ |
| Structured output (`output_format`) | **enforced** | **enforced** | **enforced** | best-effort | best-effort |
| Env injection (`env:`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cost control (`maxBudgetUsd`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Effort control (`effort`) | ✅ | ✅ | ❌ | ✅ | ✅ |
| Fallback model (`fallbackModel`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Sandbox (`sandbox`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Setting sources (`settingSources`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| In-process native tools | ✅ | ❌ | ❌ | ✅ | ❌ |
| Container exec (folder-project container backend) | ✅ | ❌ | ❌ | ❌ | ❌ |

## Caveats

- ¹ `opencode` — Inline sub-agents (`agents:`) — Config-file-based agent selection (named agents from `opencode.json`) with per-call model/tools overrides — not inline sub-agent definitions.

## Legend

- **✅ / ❌** — the capability is supported or unsupported for this provider.
- **✅¹ (superscript)** — supported, but with semantics that differ from the headline
  meaning of the axis — see [Caveats](#caveats).
- **Structured output** — `enforced` (the SDK/backend grammar-constrains decoding),
  `best-effort` (schema appended to the prompt, then validated + re-asked up to 3×),
  or ❌ (unsupported). See [AI Assistants → Structured output guarantees](/getting-started/ai-assistants/#structured-output-guarantees).
- **In-process native tools** — the provider can register Archon `NativeTool`s for a
  turn (gates auto-injection of Archon's `manage_run` tool into project-scoped chat).

For per-provider field-level notes (YAML syntax, caveats), see the
[AI Assistants guide](/getting-started/ai-assistants/).
